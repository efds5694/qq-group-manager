"""群列表、群备注与「我在群里的身份」。

``get_group_list`` 不返回自己的角色，需要按群再查一次成员信息；
群备注（QQ 里的「群备注」）要单独调 ``get_group_info`` 才有。

为了打开页面不再等，这里做了四件事：
1. 群列表整体缓存（默认 2 分钟）；
2. 角色 / 备注按账号缓存并落盘（data/cache/group-roles-<QQ>.json），下次启动直接复用；
3. 角色请求按线程池并发，几十个群也能在一两秒内拿全；
4. 群备注单独懒加载：列表先出，备注随后补（协议端不支持就记住，不再重试）。
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor

from ..core import store
from ..core.errors import AppError, UnsupportedAction
from .members import ROLE_LABELS

_CACHE: dict[tuple[str, str], dict] = {}
_LOCK = threading.Lock()
TTL = 120

_META: dict[str, dict] = {}
_META_LOCK = threading.RLock()
MAX_WORKERS = 8


def _meta_path(self_id: str):
    safe = "".join(ch for ch in str(self_id or "anon") if ch.isalnum() or ch in "-_") or "anon"
    # 沿用旧文件名，老缓存里的 roles 还能直接用
    return store.CACHE_DIR / f"group-roles-{safe}.json"


def _string_map(raw) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    return {str(key): str(value) for key, value in raw.items()}


def _meta(self_id: str) -> dict:
    """账号维度的缓存：roles / remarks / remarks_supported。"""
    key = str(self_id or "anon")
    with _META_LOCK:
        cached = _META.get(key)
        if cached:
            return cached

    data = store.read_json(_meta_path(key)) or {}
    entry = {
        "roles": _string_map(data.get("roles")),
        "remarks": _string_map(data.get("remarks")),
        "remarks_supported": data.get("remarks_supported", True) is not False,
    }
    with _META_LOCK:
        return _META.setdefault(key, entry)


def _save_meta(self_id: str, meta: dict) -> None:
    key = str(self_id or "anon")
    with _META_LOCK:
        payload = {
            "at": time.time(),
            "roles": dict(meta["roles"]),
            "remarks": dict(meta["remarks"]),
            "remarks_supported": bool(meta["remarks_supported"]),
        }
    try:
        store.write_json(_meta_path(key), payload)
    except OSError:
        pass


def _self_role(client, group_id: str, self_id: str) -> str:
    if not self_id:
        return ""
    try:
        info = client.call("get_group_member_info", group_id=group_id, user_id=self_id, no_cache=True, timeout=10)
        role = (info or {}).get("role") or ""
        return role if role in ROLE_LABELS else ""
    except AppError:
        return ""


def _fetch_roles(client, group_ids: list[str], self_id: str) -> dict[str, str]:
    if not group_ids or not self_id:
        return {}
    workers = max(1, min(MAX_WORKERS, len(group_ids)))
    result: dict[str, str] = {}

    def one(gid: str):
        return gid, _self_role(client, gid, self_id)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for gid, role in pool.map(one, group_ids):
            result[gid] = role
    return result


def _group_remark(client, group_id: str, force: bool = False) -> tuple[str | None, bool]:
    """返回 (备注, 是否支持该字段)。None 表示这次没拿到，不写缓存。"""
    try:
        from . import collection
        cached = collection.load(client, group_id).get("group", {}).get("get_group_info", {})
        info = cached["data"] if cached.get("status") == "ok" and not force else collection.fetch(client, group_id, "get_group_info")
        info = info or {}
    except UnsupportedAction:
        return None, False
    except AppError:
        return None, True

    if "group_remark" in info:  # NapCat 扩展字段
        return str(info.get("group_remark") or "").strip(), True
    if "remark" in info:  # 个别实现用的是 remark
        return str(info.get("remark") or "").strip(), True
    return None, True


def _fetch_remarks(client, group_ids: list[str], meta: dict, force: bool = False) -> bool:
    """并发补群备注，返回协议端是否提供备注字段。"""
    if not group_ids:
        return True

    workers = max(1, min(MAX_WORKERS, len(group_ids)))
    supported = True
    hits = 0

    def one(gid: str):
        return gid, *_group_remark(client, gid, force)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for gid, remark, ok in pool.map(one, group_ids):
            if not ok:
                supported = False
                continue
            if remark is None:
                continue
            hits += 1
            with _META_LOCK:
                meta["remarks"][gid] = remark

    return supported


def _apply_remarks(remarks: dict[str, str], key: tuple[str, str]) -> None:
    with _LOCK:
        cached = _CACHE.get(key)
    if not cached:
        return
    for group in cached["groups"]:
        group["group_remark"] = remarks.get(group["group_id"], "")


def fetch_remarks(client, self_id: str, group_ids: list[str], force: bool = False) -> tuple[dict, bool]:
    """补齐群备注并返回 {群号: 备注}（只含有备注的群）。"""
    ids = [str(gid) for gid in group_ids]
    if not ids or not self_id:
        return {}, False

    meta = _meta(self_id)
    if not meta["remarks_supported"] and not force:
        return {gid: remark for gid, remark in meta["remarks"].items() if gid in set(ids) and remark}, False

    pending = [gid for gid in ids if force or gid not in meta["remarks"]]
    if pending:
        supported = _fetch_remarks(client, pending, meta, force)
        if not supported:
            with _META_LOCK:
                meta["remarks_supported"] = False
        _save_meta(self_id, meta)
        _apply_remarks(meta["remarks"], (client.cache_namespace, str(self_id)))

    allowed = set(ids)
    return (
        {gid: remark for gid, remark in meta["remarks"].items() if gid in allowed and remark},
        meta["remarks_supported"],
    )


def list_groups(client, self_id: str = "", force: bool = False) -> list[dict]:
    now = time.time()
    key = (client.cache_namespace, str(self_id))
    with _LOCK:
        cached = _CACHE.get(key)

    if not cached and not force:
        cached = store.read_json(store.CACHE_DIR / f"groups-{client.cache_namespace}.json")

    if cached and not force and now - cached["at"] < TTL:
        return cached["groups"]

    raw = client.call("get_group_list", timeout=20) or []
    infos = [item for item in raw if isinstance(item, dict) and item.get("group_id")]

    ids = [str(item.get("group_id")) for item in infos]
    meta = _meta(self_id)
    roles = dict(meta["roles"])
    missing = [gid for gid in ids if force or not roles.get(gid)]

    if missing and self_id:
        roles.update(_fetch_roles(client, missing, self_id))
        roles = {gid: role for gid, role in roles.items() if gid in ids}
        with _META_LOCK:
            meta["roles"] = roles
        _save_meta(self_id, meta)

    # 有些协议端会直接带 group_remark，白拿的备注先存起来
    remark_dirty = False
    for item in infos:
        raw_remark = item.get("group_remark")
        if not isinstance(raw_remark, str):
            continue
        gid = str(item.get("group_id"))
        remark = raw_remark.strip()
        if meta["remarks"].get(gid) != remark:
            with _META_LOCK:
                meta["remarks"][gid] = remark
            remark_dirty = True
    if remark_dirty and self_id:
        _save_meta(self_id, meta)

    groups: list[dict] = []
    for item in infos:
        group_id = str(item.get("group_id") or "")
        role = roles.get(group_id) or ""
        groups.append(
            {
                **item,
                "raw": {"get_group_list": dict(item)},
                "fetched_at": now,
                "group_id": group_id,
                "group_name": (item.get("group_name") or group_id).strip(),
                "group_remark": meta["remarks"].get(group_id, ""),
                "member_count": int(item.get("member_count") or 0),
                "max_member_count": int(item.get("max_member_count") or 0),
                "my_role": role,
                "my_role_label": ROLE_LABELS.get(role, "未知"),
                "manageable": role in ("owner", "admin"),
            }
        )

    groups.sort(key=lambda entry: -entry["member_count"])
    with _LOCK:
        _CACHE[key] = {"at": now, "groups": groups}
    store.write_json(store.CACHE_DIR / f"groups-{client.cache_namespace}.json", {"at": now, "groups": groups})
    return groups


def find(groups: list[dict], group_id: str) -> dict:
    for group in groups:
        if group["group_id"] == str(group_id):
            return group
    return {"group_id": str(group_id), "group_name": str(group_id), "member_count": 0, "my_role": "", "manageable": False}


def invalidate() -> None:
    with _LOCK:
        _CACHE.clear()
