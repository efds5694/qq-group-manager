"""REST 接口层：参数校验 + 编排服务，不放业务细节。"""

from __future__ import annotations

import threading
import time

from . import config as config_mod
from .core import exporter, store
from .core.errors import AppError
from .onebot import adapters, probe
from .onebot.client import OneBotClient
from .server import Request, Response, Router
from .services import cards, groups, groupsettings, jobs, members

_STATE: dict = {"client": None, "key": None, "session": None}
_LOCK = threading.RLock()


# ------------------------------------------------------------------ 基础设施
def _config() -> dict:
    return config_mod.load()


def _active_client() -> tuple[OneBotClient, dict]:
    cfg = _config()
    profile = config_mod.active_profile(cfg)
    key = (profile.get("base_url"), profile.get("token"), profile.get("adapter"))
    with _LOCK:
        if _STATE["client"] is None or _STATE["key"] != key:
            _STATE["client"] = OneBotClient(profile["base_url"], profile.get("token", ""))
            _STATE["key"] = key
            _STATE["session"] = None
        return _STATE["client"], profile


def _reset_client() -> None:
    with _LOCK:
        _STATE.update({"client": None, "key": None, "session": None})
    groups.invalidate()
    members.invalidate()


def _session(force: bool = False) -> dict:
    client, profile = _active_client()
    with _LOCK:
        cached = _STATE["session"]
    if cached and not force:
        return cached

    result = probe.probe(client, profile.get("adapter") or "napcat")
    with _LOCK:
        _STATE["session"] = result
    store.log_event(
        "connect",
        user_id=result["login"]["user_id"],
        nickname=result["login"]["nickname"],
        base_url=profile.get("base_url"),
        adapter=profile.get("adapter"),
    )
    return result


def _context(group_id: str) -> dict:
    session = _session()
    client, _ = _active_client()
    entry = members.fetch(client, group_id)
    group = groups.find(groups.list_groups(client, session["login"]["user_id"]), group_id)
    self_id = str(session["login"]["user_id"])
    self_member = next((item for item in entry["members"] if item["qq"] == self_id), None)
    self_role = (self_member or {}).get("role") or group.get("my_role") or "member"
    return {
        "client": client,
        "session": session,
        "entry": entry,
        "group": group,
        "self_id": self_id,
        "self_role": self_role,
        "caps": session.get("capabilities") or {},
    }


def _group_ids(value: str) -> list[str]:
    ids: list[str] = []
    for part in (value or "").replace("\n", ",").replace(" ", ",").split(","):
        part = part.strip()
        if part and part not in ids:
            ids.append(part)
    return ids


def _safe_name(text: str, fallback: str = "导出") -> str:
    name = "".join(ch for ch in str(text or "") if ch not in '\\/:*?"<>|').strip()
    return name[:60] or fallback


def _deliver(header: list[str], rows: list[list[str]], filename: str, fmt: str, sheet_title: str = "群成员"):
    """按格式输出文件；tsv 用于复制到剪贴板（前端 fetch 文本）。"""
    if fmt == "xlsx":
        raw = exporter.rows_to_xlsx(header, rows, sheet_title=sheet_title)
        if raw is None:
            raise AppError("未安装 openpyxl，无法导出 xlsx", hint="pip install openpyxl，或改用 CSV 导出。")
        return Response.download(
            raw,
            f"{filename}.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
    if fmt == "tsv":
        return Response(exporter.rows_to_tsv(header, rows), 200, {"Content-Type": "text/plain; charset=utf-8"})
    return Response.download(exporter.rows_to_csv(header, rows), f"{filename}.csv", "text/csv; charset=utf-8")


def _interval(value) -> float:
    batch = _config().get("batch", {})
    try:
        interval = float(value)
    except (TypeError, ValueError):
        interval = float(batch.get("interval", 2.0))
    return max(float(batch.get("min_interval", 0.8)), min(float(batch.get("max_interval", 10.0)), interval))


# ------------------------------------------------------------------ 配置与连接
def api_config(request: Request):
    cfg = _config()
    view = config_mod.public_view(cfg)
    view["adapters"] = adapters.list_adapters()
    view["formats"] = exporter.supported_formats()
    view["field_labels"] = exporter.FIELD_LABELS
    view["default_fields"] = exporter.DEFAULT_FIELDS
    return view


def api_save_profile(request: Request):
    profile = request.b("profile") or {}
    if not profile.get("base_url"):
        raise AppError("请填写服务地址", hint="例如 http://127.0.0.1:3000")
    config_mod.upsert_profile(_config(), profile)
    _reset_client()
    return api_config(request)


def api_connect(request: Request):
    session = _session(force=True)
    return {"session": session, "config": api_config(request)}


def api_capabilities(request: Request):
    return _session(force=request.q("refresh") == "1")


# ------------------------------------------------------------------ 群与成员
def api_groups(request: Request):
    session = _session()
    client, _ = _active_client()
    data = groups.list_groups(client, session["login"]["user_id"], force=request.q("refresh") == "1")
    return {"groups": data, "self": session["login"]}


def api_group_remarks(request: Request):
    """懒加载群备注：列表先返回，备注随后补齐，避免首次打开变慢。"""
    session = _session()
    client, _ = _active_client()
    self_id = str(session["login"]["user_id"])
    data = groups.list_groups(client, self_id)
    remarks, supported = groups.fetch_remarks(
        client,
        self_id,
        [item["group_id"] for item in data],
        force=request.q("refresh") == "1",
    )
    return {"remarks": remarks, "supported": supported}


def api_members(request: Request, gid: str):
    session = _session()
    client, _ = _active_client()
    entry = members.fetch(client, gid, force=request.q("refresh") == "1")
    group = groups.find(groups.list_groups(client, session["login"]["user_id"]), gid)
    self_id = str(session["login"]["user_id"])
    self_member = next((item for item in entry["members"] if item["qq"] == self_id), None)
    ctx = {
        "entry": entry,
        "group": group,
        "self_id": self_id,
        "self_role": (self_member or {}).get("role") or group.get("my_role") or "member",
    }
    result = members.query(
        entry,
        keyword=request.q("q"),
        role=request.q("role", "all"),
        year=request.q("year", "all"),
        sort=request.q("sort", "join_time"),
        desc=request.q("desc", "1") != "0",
        page=int(request.q("page", "1") or 1),
        size=int(request.q("size", "200") or 200),
    )
    result["group"] = ctx["group"]
    result["self"] = {"user_id": ctx["self_id"], "role": ctx["self_role"]}
    return result


def api_export(request: Request, gid: str):
    ctx = _context(gid)
    fields = exporter.normalize_fields([name for name in request.q("fields").split(",") if name])
    fmt = request.q("format", "csv")
    scope = request.q("scope", "filtered")

    if scope == "selected":
        selected = {name for name in request.q("selected").split(",") if name}
        rows = [item for item in ctx["entry"]["members"] if item["qq"] in selected]
    else:
        rows = members.filtered_members(
            ctx["entry"],
            keyword=request.q("q"),
            role=request.q("role", "all"),
            year=request.q("year", "all"),
            sort=request.q("sort", "join_time"),
            desc=request.q("desc", "1") != "0",
        )

    group_name = ctx["group"].get("group_name") or gid
    stamp = time.strftime("%Y%m%d-%H%M")
    safe_name = _safe_name(group_name, gid)

    if fmt == "xlsx":
        raw = exporter.to_xlsx(rows, fields, sheet_title=safe_name)
        if raw is None:
            raise AppError("未安装 openpyxl，无法导出 xlsx", hint="pip install openpyxl，或改用 CSV 导出。")
        return Response.download(
            raw,
            f"{safe_name}_{gid}_{stamp}.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )

    if fmt == "tsv":
        return Response(exporter.to_tsv(rows, fields), 200, {"Content-Type": "text/plain; charset=utf-8"})

    raw = exporter.to_csv(rows, fields)
    return Response.download(raw, f"{safe_name}_{gid}_{stamp}.csv", "text/csv; charset=utf-8")


def api_export_groups(request: Request):
    """多个群合并导出：每行带上群号 / 群名，方便一张表里筛选。"""
    ids = _group_ids(request.q("groups"))
    if not ids:
        raise AppError("请先选择要导出的群", hint="在群组页勾选多个群后再导出。")

    fields = exporter.normalize_fields([name for name in request.q("fields").split(",") if name])
    fmt = request.q("format", "csv")
    session = _session()
    client, _ = _active_client()

    entries, errors = members.fetch_many(client, ids)
    if errors:
        failed = "、".join(errors.keys())
        raise AppError(
            f"有 {len(errors)} 个群拉取成员失败",
            hint=f"失败的群：{failed}。确认账号仍在群内，或稍后重试。",
        )

    names = {item["group_id"]: item["group_name"] for item in groups.list_groups(client, session["login"]["user_id"])}
    header = ["群号", "群名"] + [exporter.FIELD_LABELS[name] for name in fields]
    rows: list[list[str]] = []
    for gid in ids:
        entry = entries.get(gid)
        if not entry:
            continue
        group_name = names.get(gid) or gid
        for member in members.filtered_members(
            entry,
            keyword=request.q("q"),
            role=request.q("role", "all"),
            year=request.q("year", "all"),
            sort=request.q("sort", "join_time"),
            desc=request.q("desc", "1") != "0",
        ):
            rows.append([gid, group_name] + exporter.build_row(member, fields))

    stamp = time.strftime("%Y%m%d-%H%M")
    filename = f"群成员汇总_{len(ids)}个群_{stamp}"
    return _deliver(header, rows, filename, fmt, sheet_title="群成员汇总")


# ------------------------------------------------------------------ 共同群成员
def _common_context(request: Request) -> tuple[list[str], dict, dict, dict]:
    ids = _group_ids(request.q("groups"))
    if len(ids) < 2:
        raise AppError("至少选择两个群", hint="共同成员需要对比两个及以上群聊。")
    session = _session()
    client, _ = _active_client()
    entries, errors = members.fetch_many(client, ids, force=request.q("refresh") == "1")
    if errors:
        failed = "、".join(errors.keys())
        raise AppError(
            f"有 {len(errors)} 个群拉取成员失败",
            hint=f"失败的群：{failed}。确认账号仍在群内，或稍后重试。",
        )
    names = {item["group_id"]: item["group_name"] for item in groups.list_groups(client, session["login"]["user_id"])}
    return ids, entries, names, session


def api_members_common(request: Request):
    _, entries, names, _ = _common_context(request)
    return members.common_members(entries, names, keyword=request.q("q"))


def api_export_common(request: Request):
    ids, entries, names, _ = _common_context(request)
    result = members.common_members(entries, names, keyword=request.q("q"))
    fmt = request.q("format", "csv")

    header = ["QQ号", "昵称", "共同群数"]
    for group in result["groups"]:
        label = f"{group['group_name']}（{group['group_id']}）"
        header.extend([f"群名片·{label}", f"身份·{label}", f"加群时间·{label}"])

    rows: list[list[str]] = []
    for item in result["items"]:
        line = [item["qq"], item["nickname"], str(item["count"])]
        for group in result["groups"]:
            info = item["groups"].get(group["group_id"]) or {}
            line.extend(
                [
                    info.get("card") or info.get("display_name") or "",
                    info.get("role_label") or "",
                    info.get("join_time") or "",
                ]
            )
        rows.append(line)

    stamp = time.strftime("%Y%m%d-%H%M")
    filename = f"共同群成员_{len(ids)}个群_{stamp}"
    return _deliver(header, rows, filename, fmt, sheet_title="共同群成员")


# ------------------------------------------------------------------ 批量改名片
def api_cards_preview(request: Request):
    gid = str(request.b("group_id") or "")
    if not gid:
        raise AppError("请先选择一个群")
    options = request.b("options") or {}
    ctx = _context(gid)
    plan = cards.preview(
        ctx["entry"]["members"],
        ctx["group"],
        options,
        ctx["self_id"],
        ctx["self_role"],
        interval=_interval(options.get("interval")),
    )
    plan["interval"] = _interval(options.get("interval"))
    plan["self_role"] = ctx["self_role"]
    plan["options"] = options
    return plan


def api_cards_execute(request: Request):
    gid = str(request.b("group_id") or "")
    options = request.b("options") or {}
    mode = request.b("mode") or "trial"
    if not gid:
        raise AppError("请先选择一个群")

    ctx = _context(gid)
    interval = _interval(options.get("interval"))
    plan = cards.preview(
        ctx["entry"]["members"], ctx["group"], options, ctx["self_id"], ctx["self_role"], interval=interval
    )

    items = plan["items"]
    if not items:
        raise AppError("没有需要修改的成员", hint="检查模板与作用范围，或成员名片本来就一致。")

    if mode == "trial":
        limit = int(_config().get("batch", {}).get("trial_size", 10))
        items = items[:limit]
        title = f"试改 {len(items)} 人 · {ctx['group']['group_name']}"
    else:
        if len(items) > 100 and not request.b("confirmed"):
            raise AppError(
                f"本次将修改 {len(items)} 人",
                hint="全量执行超过 100 人需要二次确认，请勾选确认后重试。",
            )
        title = f"批量改名片 {len(items)} 人 · {ctx['group']['group_name']}"

    snapshot = store.save_snapshot(
        "cards",
        gid,
        {
            "group_name": ctx["group"].get("group_name", ""),
            "note": title,
            "members": [
                {"qq": item["qq"], "card": item["old_card"], "nickname": item["nickname"]}
                for item in items
            ],
        },
        note=title,
    )

    task_list = cards.build_tasks(items, gid)
    job = jobs.MANAGER.submit(
        ctx["client"],
        "card",
        task_list,
        title=title,
        interval=interval,
        retries=int(_config().get("batch", {}).get("retries", 2)),
        meta={"group_id": gid, "group_name": ctx["group"].get("group_name"), "snapshot_id": snapshot["id"]},
    )
    members.invalidate(gid)
    return {"job": job, "snapshot": snapshot, "planned": len(items), "skipped": plan["stats"]["skip"]}


# ------------------------------------------------------------------ 群设置模板
def api_settings_preview(request: Request):
    group_ids = [str(item) for item in (request.b("group_ids") or [])]
    if not group_ids:
        raise AppError("请至少选择一个群")
    template = request.b("template") or {}
    ctx = _context(group_ids[0])
    client = ctx["client"]
    all_groups = groups.list_groups(client, ctx["self_id"])
    targets = [groups.find(all_groups, gid) for gid in group_ids]
    adapter = adapters.get_adapter(_session()["adapter"])
    return groupsettings.build_diff(client, targets, template, ctx["caps"], adapter)


def api_settings_execute(request: Request):
    group_ids = [str(item) for item in (request.b("group_ids") or [])]
    template = request.b("template") or {}
    if not group_ids:
        raise AppError("请至少选择一个群")
    if len(group_ids) * 6 > 100 and not request.b("confirmed"):
        raise AppError("即将对多个群批量套用设置", hint="请确认目标群无误后重试。")

    ctx = _context(group_ids[0])
    adapter = adapters.get_adapter(_session()["adapter"])
    all_groups = groups.list_groups(ctx["client"], ctx["self_id"])
    targets = [groups.find(all_groups, gid) for gid in group_ids]
    diff = groupsettings.build_diff(ctx["client"], targets, template, ctx["caps"], adapter)

    task_list = groupsettings.build_tasks(diff["groups"], diff["template"])
    if not task_list:
        raise AppError("没有需要变更的设置", hint="模板内容与当前群设置一致，或接口不支持。")

    snapshot = store.save_snapshot(
        "settings",
        "multi",
        {
            "group_name": "、".join(group["group_name"] for group in diff["groups"])[:60],
            "note": diff["template"]["name"],
            "entries": [
                {"group_id": group["group_id"], "group_name": group["group_name"]} for group in diff["groups"]
            ],
        },
        note=f"套用模板：{diff['template']['name']}",
    )

    job = jobs.MANAGER.submit(
        ctx["client"],
        "settings",
        task_list,
        title=f"套用模板「{diff['template']['name']}」· {len(diff['groups'])} 个群",
        interval=_interval(request.b("interval")),
        retries=int(_config().get("batch", {}).get("retries", 2)),
        meta={"groups": group_ids, "snapshot_id": snapshot["id"]},
    )
    groups.invalidate()
    return {"job": job, "snapshot": snapshot, "diff": diff, "planned": len(task_list)}


# ------------------------------------------------------------------ 任务与快照
def api_jobs(request: Request):
    return {"jobs": jobs.MANAGER.list()}


def api_job(request: Request, jid: str):
    return jobs.MANAGER.get(jid)


def api_job_cancel(request: Request, jid: str):
    return jobs.MANAGER.cancel(jid)


def api_snapshots(request: Request):
    return {"snapshots": store.list_snapshots()}


def api_rollback(request: Request, snapshot_id: str):
    snapshot = store.load_snapshot(snapshot_id)
    if snapshot.get("kind") != "cards":
        raise AppError("该快照不支持回滚", hint="只有改名片快照可以回滚。")
    group_id = str(snapshot.get("group_id") or "")
    entries = snapshot.get("members") or []
    if not entries:
        raise AppError("快照里没有可回滚的成员")

    client, _ = _active_client()
    interval = _interval(request.b("interval"))
    task_list = cards.build_rollback_tasks(snapshot, group_id)
    job = jobs.MANAGER.submit(
        client,
        "rollback",
        task_list,
        title=f"回滚名片 · {snapshot.get('group_name') or group_id} · {len(task_list)} 人",
        interval=interval,
        retries=int(_config().get("batch", {}).get("retries", 2)),
        meta={"group_id": group_id, "snapshot_id": snapshot_id},
    )
    members.invalidate(group_id)
    return {"job": job, "planned": len(task_list)}


def api_logs(request: Request):
    return {"logs": store.recent_logs(limit=int(request.q("limit", "200") or 200))}


# ------------------------------------------------------------------ 模板管理
def api_save_template(request: Request):
    template = request.b("template") or {}
    cfg = _config()
    saved = config_mod.save_template(cfg, template)
    return {"template": saved, "config": config_mod.public_view(cfg)}


def api_delete_template(request: Request, template_id: str):
    cfg = _config()
    config_mod.delete_template(cfg, template_id)
    return config_mod.public_view(cfg)


# ------------------------------------------------------------------ 路由表
def build_router() -> Router:
    router = Router()
    router.add("GET", r"^/api/config$", api_config)
    router.add("POST", r"^/api/config/profile$", api_save_profile)
    router.add("POST", r"^/api/connect$", api_connect)
    router.add("GET", r"^/api/capabilities$", api_capabilities)

    router.add("GET", r"^/api/groups$", api_groups)
    router.add("GET", r"^/api/groups/remarks$", api_group_remarks)
    router.add("GET", r"^/api/groups/(?P<gid>[^/]+)/members$", api_members)
    router.add("GET", r"^/api/groups/(?P<gid>[^/]+)/export$", api_export)

    router.add("GET", r"^/api/export/groups$", api_export_groups)
    router.add("GET", r"^/api/members/common$", api_members_common)
    router.add("GET", r"^/api/export/common$", api_export_common)

    router.add("POST", r"^/api/cards/preview$", api_cards_preview)
    router.add("POST", r"^/api/cards/execute$", api_cards_execute)

    router.add("POST", r"^/api/settings/preview$", api_settings_preview)
    router.add("POST", r"^/api/settings/execute$", api_settings_execute)

    router.add("GET", r"^/api/jobs$", api_jobs)
    router.add("GET", r"^/api/jobs/(?P<jid>[^/]+)$", api_job)
    router.add("POST", r"^/api/jobs/(?P<jid>[^/]+)/cancel$", api_job_cancel)

    router.add("GET", r"^/api/snapshots$", api_snapshots)
    router.add("POST", r"^/api/snapshots/(?P<snapshot_id>[^/]+)/rollback$", api_rollback)

    router.add("GET", r"^/api/logs$", api_logs)
    router.add("POST", r"^/api/templates$", api_save_template)
    router.add("DELETE", r"^/api/templates/(?P<template_id>[^/]+)$", api_delete_template)
    return router
