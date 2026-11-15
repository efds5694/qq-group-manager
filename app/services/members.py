"""群成员拉取、缓存、筛选排序。

大群一次拉取可能要几秒，因此做了两层缓存：
1. 内存缓存（默认 5 分钟）；
2. 磁盘缓存（data/cache/members-<连接及账号标识>-<群号>.json），重启后也能秒开。

命中旧缓存时先返回旧数据，同时在后台线程刷新，
前端显示「数据时间」，需要绝对最新时点刷新按钮强制重拉。
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor

from ..core import store
from ..core.errors import AppError
from ..core.template import CARD_MAX_LEN, clamp

ROLE_LABELS = {"owner": "群主", "admin": "管理员", "member": "成员"}
ROLE_ORDER = {"owner": 0, "admin": 1, "member": 2}

_CACHE: dict[tuple[str, str], dict] = {}
_LOCK = threading.Lock()
_REFRESHING: set[tuple[str, str]] = set()
DEFAULT_TTL = 300
# 磁盘缓存超过这个时间就不先给旧数据了，直接等新数据（避免展示几天前的名单）
STALE_OK = 6 * 3600
MAX_WORKERS = 4


def _fmt_time(timestamp) -> str:
    try:
        value = int(timestamp or 0)
    except (TypeError, ValueError):
        return ""
    if value <= 0:
        return ""
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(value))


def _year(timestamp) -> str:
    try:
        value = int(timestamp or 0)
    except (TypeError, ValueError):
        return ""
    if value <= 0:
        return ""
    return str(time.localtime(value).tm_year)


def normalize(member: dict) -> dict:
    role = (member.get("role") or "member").lower()
    if role not in ROLE_LABELS:
        role = "member"
    qq = str(member.get("user_id") or "")
    card = (member.get("card") or "").strip()
    nickname = (member.get("nickname") or "").strip()
    return {
        **member,
        "raw": {"get_group_member_list": dict(member)},
        "qq": qq,
        "nickname": nickname,
        "card": card,
        "display_name": card or nickname,
        "role": role,
        "role_label": ROLE_LABELS[role],
        "level": str(member.get("level") or ""),
        "title": member.get("title") or "",
        "join_time": _fmt_time(member.get("join_time")),
        "join_year": _year(member.get("join_time")),
        "join_ts": int(member.get("join_time") or 0),
        "last_sent_time": _fmt_time(member.get("last_sent_time")),
        "last_sent_ts": int(member.get("last_sent_time") or 0),
        "is_robot": bool(member.get("is_robot")),
    }


# ------------------------------------------------------------------ 缓存
def _key(client, group_id: str) -> tuple[str, str]:
    return (client.cache_namespace, str(group_id))


def _disk_path(group_id: str, namespace: str):
    safe = "".join(ch for ch in str(group_id) if ch.isalnum() or ch in "-_") or "unknown"
    return store.CACHE_DIR / f"members-{namespace}-{safe}.json"


def _load_disk(group_id: str, namespace: str) -> dict | None:
    data = store.read_json(_disk_path(group_id, namespace))
    if not isinstance(data, dict) or not isinstance(data.get("members"), list):
        return None
    return {
        "group_id": str(data.get("group_id") or group_id),
        "fetched_at": float(data.get("fetched_at") or 0),
        "members": data["members"],
    }


def _save_disk(entry: dict, namespace: str) -> None:
    try:
        store.write_json(
            _disk_path(entry["group_id"], namespace),
            {
                "group_id": entry["group_id"],
                "fetched_at": entry["fetched_at"],
                "members": entry["members"],
            },
        )
    except OSError:
        pass


def _fetch_remote(client, group_id: str, force: bool = False) -> dict:
    raw = client.call("get_group_member_list", group_id=group_id, timeout=120, **({"no_cache": True} if force else {}))
    if not isinstance(raw, list):
        raise AppError("成员列表返回格式异常", hint="协议端版本可能不兼容，检查 NapCat 是否为新版。")

    members = [normalize(item) for item in raw if isinstance(item, dict)]
    members.sort(key=lambda item: (ROLE_ORDER.get(item["role"], 9), item["qq"]))

    entry = {"group_id": group_id, "fetched_at": time.time(), "members": members}
    with _LOCK:
        _CACHE[_key(client, group_id)] = entry
    _save_disk(entry, client.cache_namespace)
    return entry


def _refresh_async(client, group_id: str) -> None:
    with _LOCK:
        if _key(client, group_id) in _REFRESHING:
            return
        _REFRESHING.add(_key(client, group_id))

    def run() -> None:
        try:
            _fetch_remote(client, group_id)
        except Exception:
            pass
        finally:
            with _LOCK:
                _REFRESHING.discard(_key(client, group_id))

    threading.Thread(target=run, daemon=True, name=f"members-refresh-{group_id}").start()


def fetch(client, group_id: str, force: bool = False, ttl: int = DEFAULT_TTL) -> dict:
    group_id = str(group_id)
    now = time.time()

    with _LOCK:
        cached = _CACHE.get(_key(client, group_id))

    if cached and not force and now - cached["fetched_at"] < ttl:
        return cached

    if cached and not force:
        # 旧数据先顶上，后台悄悄刷新
        _refresh_async(client, group_id)
        return {**cached, "stale": True}

    if not force:
        disk = _load_disk(group_id, client.cache_namespace)
        if disk and now - disk["fetched_at"] < STALE_OK:
            with _LOCK:
                _CACHE[_key(client, group_id)] = disk
            _refresh_async(client, group_id)
            return {**disk, "stale": True}

    return _fetch_remote(client, group_id, force)


def fetch_many(client, group_ids: list[str], force: bool = False) -> tuple[dict[str, dict], dict[str, Exception]]:
    """并发拉取多个群，返回 (成功结果, 失败信息)。"""
    ids: list[str] = []
    for gid in group_ids:
        gid = str(gid)
        if gid and gid not in ids:
            ids.append(gid)

    entries: dict[str, dict] = {}
    errors: dict[str, Exception] = {}
    if not ids:
        return entries, errors

    workers = max(1, min(MAX_WORKERS, len(ids)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch, client, gid, force): gid for gid in ids}
        for future, gid in futures.items():
            try:
                entries[gid] = future.result()
            except Exception as exc:  # noqa: BLE001 - 单个群失败不影响其它群
                errors[gid] = exc
    return entries, errors


def invalidate(group_id: str | None = None) -> None:
    with _LOCK:
        if group_id:
            for key in list(_CACHE):
                if key[1] == str(group_id):
                    _CACHE.pop(key, None)
        else:
            _CACHE.clear()


def cached(client, group_id: str) -> dict | None:
    with _LOCK:
        return _CACHE.get(_key(client, group_id))


def expire(client, group_id: str) -> None:
    """写任务结束后丢弃该连接的旧名单，下次读取直接获取真实结果。"""
    with _LOCK:
        _CACHE.pop(_key(client, group_id), None)
    try:
        _disk_path(group_id, client.cache_namespace).unlink(missing_ok=True)
    except OSError:
        pass


# ------------------------------------------------------------------ 查询
def filtered_members(
    entry: dict,
    keyword: str = "",
    role: str = "all",
    year: str = "all",
    sort: str = "join_time",
    desc: bool = True,
) -> list[dict]:
    members = entry["members"]
    keyword = (keyword or "").strip().lower()

    filtered = members
    if keyword:
        filtered = [
            item
            for item in filtered
            if keyword in item["qq"]
            or keyword in item["nickname"].lower()
            or keyword in item["card"].lower()
        ]
    if role and role != "all":
        filtered = [item for item in filtered if item["role"] == role]
    if year and year != "all":
        filtered = [item for item in filtered if item["join_year"] == str(year)]

    sort_keys = {
        "join_time": lambda item: item["join_ts"],
        "last_sent_time": lambda item: item["last_sent_ts"],
        "qq": lambda item: int(item["qq"] or 0),
        "nickname": lambda item: item["display_name"],
        "role": lambda item: ROLE_ORDER.get(item["role"], 9),
    }
    key = sort_keys.get(sort, sort_keys["join_time"])
    return sorted(filtered, key=key, reverse=bool(desc))


def query(
    entry: dict,
    keyword: str = "",
    role: str = "all",
    year: str = "all",
    sort: str = "join_time",
    desc: bool = True,
    page: int = 1,
    size: int = 200,
) -> dict:
    members = entry["members"]
    filtered = filtered_members(entry, keyword, role, year, sort, desc)

    size = max(1, min(int(size or 200), 5000))
    page = max(1, int(page or 1))
    start = (page - 1) * size
    page_items = filtered[start : start + size]

    counts = {
        "owner": sum(1 for item in members if item["role"] == "owner"),
        "admin": sum(1 for item in members if item["role"] == "admin"),
        "member": sum(1 for item in members if item["role"] == "member"),
        "empty_card": sum(1 for item in members if not item["card"]),
    }
    years = sorted({item["join_year"] for item in members if item["join_year"]}, reverse=True)

    return {
        "group_id": entry.get("group_id", ""),
        "items": page_items,
        "total": len(filtered),
        "all_total": len(members),
        "page": page,
        "size": size,
        "pages": max(1, (len(filtered) + size - 1) // size),
        "counts": counts,
        "years": years,
        "fetched_at": time.strftime("%H:%M:%S", time.localtime(entry["fetched_at"])),
        "stale": bool(entry.get("stale")),
    }


# ------------------------------------------------------------------ 跨群成员
def common_members(
    entries: dict[str, dict],
    group_names: dict[str, str],
    keyword: str = "",
    *,
    source_groups: list[str] | None = None,
    mode: str = "all",
    in_groups: list[str] | None = None,
    not_in_groups: list[str] | None = None,
    status: str = "all",
    selected: list[str] | None = None,
    sort: str = "count",
    page: int = 1,
    size: int | None = 50,
) -> dict:
    """以 QQ 合并成员并集；查看、导出和同步预演共用同一套筛选。size=None 不分页。"""
    gids = list(entries.keys())
    sources = list(dict.fromkeys(gid for gid in (source_groups or []) if gid in entries))
    targets = [gid for gid in gids if gid not in sources]
    table: dict[str, dict] = {}

    for gid in gids:
        for member in entries[gid]["members"]:
            row = table.get(member["qq"])
            if row is None:
                row = {"qq": member["qq"], "nickname": member["nickname"], "groups": {}}
                table[member["qq"]] = row
            row["groups"][gid] = {
                "card": member["card"],
                "nickname": member["nickname"],
                "display_name": member["display_name"],
                "role": member["role"],
                "role_label": member["role_label"],
                "join_time": member["join_time"],
            }

    rows = list(table.values())
    for row in rows:
        memberships = row["groups"]
        references = [(gid, memberships[gid]["card"]) for gid in sources
                      if gid in memberships and memberships[gid]["card"]]
        row["count"] = len(memberships)
        row["source_group_id"], row["reference_card"] = references[0] if references else ("", "")
        row["source_conflict"] = len({card for _, card in references}) > 1
        expected = clamp(row["reference_card"], CARD_MAX_LEN)[0]
        row["different"] = bool(expected) and any(
            gid in memberships and memberships[gid]["card"] != expected for gid in targets
        )

    counts = {
        "all": len(rows),
        "single": sum(row["count"] == 1 for row in rows),
        "multiple": sum(row["count"] > 1 for row in rows),
        "different": sum(row["different"] for row in rows),
        "no_reference": sum(not row["reference_card"] for row in rows),
    }
    if mode == "multiple":
        rows = [row for row in rows if row["count"] > 1]
    elif mode == "single":
        rows = [row for row in rows if row["count"] == 1]
    elif mode == "intersection":
        rows = [row for row in rows if row["count"] == len(gids)]
    required, excluded = set(in_groups or []), set(not_in_groups or [])
    rows = [row for row in rows if required.issubset(row["groups"]) and not excluded.intersection(row["groups"])]
    if status == "different":
        rows = [row for row in rows if row["different"]]
    elif status == "no_reference":
        rows = [row for row in rows if not row["reference_card"]]
    if selected is not None:
        chosen = set(selected)
        rows = [row for row in rows if row["qq"] in chosen]

    text = (keyword or "").strip().lower()
    if text:
        rows = [
            row
            for row in rows
            if text in row["qq"]
            or text in (row["nickname"] or "").lower()
            or any(
                text in (info.get("card") or "").lower() or text in (info.get("nickname") or "").lower()
                for info in row["groups"].values()
            )
        ]

    qq_key = lambda row: (len(row["qq"]), row["qq"])
    rows.sort(key=qq_key)
    if sort == "name":
        rows.sort(key=lambda row: (row["reference_card"] or row["nickname"]).casefold())
    elif sort != "qq":
        rows.sort(key=lambda row: -row["count"])
    total = len(rows)
    pages = max(1, (total + size - 1) // size) if size else 1
    page = max(1, min(page, pages))
    items = rows[(page - 1) * size:page * size] if size else rows

    return {
        "items": items,
        "total": total,
        "all_total": counts["all"],
        "counts": counts,
        "page": page,
        "size": size,
        "pages": pages,
        "count": len(gids),
        "groups": [
            {"group_id": gid, "group_name": group_names.get(gid) or gid,
             "is_source": gid in sources,
             "fetched_at": _fmt_time(entries[gid]["fetched_at"]),
             "stale": bool(entries[gid].get("stale"))} for gid in gids
        ],
    }
