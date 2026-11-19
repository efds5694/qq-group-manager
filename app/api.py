"""REST 接口层：参数校验 + 编排服务，不放业务细节。"""

from __future__ import annotations

import threading
import time
import csv
import io
import uuid

from . import config as config_mod
from .core import exporter, store, fields
from .core.errors import AppError
from .onebot import adapters, probe
from .onebot.client import OneBotClient
from .server import Request, Response, Router
from .services import cards, groups, groupsettings, jobs, members, query, collection, presets, rename, results, comparison, rosters, roster_match, member_actions

_STATE: dict = {"client": None, "key": None, "session": None}
_LOCK = threading.RLock()
_SETTINGS_PREVIEWS: dict[str, dict] = {}


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
        _SETTINGS_PREVIEWS.clear()
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


def _query_data(spec, on_progress=None):
    session = _session()
    client, _ = _active_client()
    dataset = query.prepare(client, str(session["login"]["user_id"]), spec,
                            **({"on_progress": on_progress} if on_progress else {}))
    pending = query.pending_collection(client, dataset, spec)
    return dataset, pending


def _background(request, title, work):
    if not request.b("background"):
        return work(None)
    client, _ = _active_client()
    return {"pending": True, "job": jobs.MANAGER.submit(
        client, "load", [{"action": "read", "run": work}], title=title, interval=0, retries=0)}


def api_query(request: Request):
    def read(progress):
        dataset, pending = _query_data(request.body, progress)
        if pending:
            return {"pending": True, "job": pending, "fields": dataset["fields"]}
        if progress:
            progress("筛选与整理结果")
        return query.execute(dataset, request.body)
    return _background(request, "读取资料", read)


def _result_owner():
    session = _session()
    client, _ = _active_client()
    return (client.cache_namespace, str(session["login"]["user_id"]))


def api_query_start(request: Request):
    def read(progress):
        dataset, pending = _query_data(request.body, progress)
        if pending:
            return {"pending": True, "job": pending}
        if progress:
            progress("筛选与整理结果")
        result = query.execute(dataset, request.body, paginate=False)
        result["entity"] = dataset["entity"]
        result["matrix"] = bool(request.b("matrix"))
        if request.b("project_selection") is not None and dataset["entity"] in ("people", "memberships"):
            accounts = set(request.b("project_selection"))
            result["projected_selection"] = [row["id"] for row in result["items"] if row["qq"] in accounts]
        return results.STORE.create(_result_owner(), result, request.body)
    title = "读取群列表" if request.b("entity") == "groups" else "读取成员名单"
    return _background(request, title, read)


def api_result_window(request: Request, query_id: str):
    return results.STORE.window(_result_owner(), query_id, request.q("offset", "0"), request.q("limit", "200"))


def api_result_selection(request: Request, query_id: str):
    return results.STORE.selection(_result_owner(), query_id)


def api_result_position(request: Request, query_id: str):
    return results.STORE.position(_result_owner(), query_id, request.q("id"))


def api_members_compare(request: Request):
    return _background(request, "读取并核对成员名单", lambda progress: _members_compare(request, progress))


def api_match_roster(request: Request):
    owner = _result_owner()
    client, _ = _active_client()
    sources = member_actions.group_ids(request.b("source_ids"))

    def read(progress):
        imported = roster_match.read(request.body)
        names, lists = member_actions.read_sources(client, owner[1], sources, progress)
        if progress:
            progress("匹配姓名、班级、学号和手机号")
        rows, accounts = roster_match.match(imported, names, lists)
        preview = results.STORE.create(owner, {"entity": "roster_match", "items": []},
                                       {"rows": rows, "accounts": list(accounts), "source_ids": sources})
        return {"preview_id": preview["query_id"], "rows": rows}

    return _background(request, "按名单匹配 QQ账号", read)


def api_match_roster_confirm(request: Request):
    plan = results.STORE.plan(_result_owner(), request.b("preview_id", ""), "roster_match")
    qqs = roster_match.confirm(plan["rows"], set(plan["accounts"]), request.b("assignments"))
    return {"qqs": qqs, "source_ids": plan["source_ids"]}


def api_match_roster_export(request: Request):
    plan = results.STORE.plan(_result_owner(), request.b("preview_id", ""), "roster_match")
    confirmed = request.b("assignments") or {}
    if not isinstance(confirmed, dict):
        raise AppError("无效的确认名单")
    statuses = {"matched": "尚未确认", "review": "仅姓名相同", "conflict": "需要核对", "missing": "未匹配"}
    columns = ["name", "class", "student", "phone", "input_qq"]
    rows = [[row[key] for key in columns] + [statuses[row["status"]]]
            for row in plan["rows"] if row["id"] not in confirmed]
    return _deliver(["姓名", "班级", "学号", "手机号（遮盖）", "输入QQ号", "匹配状态"],
                    rows, "未确认名单", "csv")


def api_member_action_preview(request: Request):
    owner = _result_owner()
    session = _session()
    client, _ = _active_client()
    record = None
    if request.b("tracking_id"):
        roster = rosters.load(owner[1], request.b("tracking_id"))
        if not roster.get("source_ids") or request.b("group_id") != roster["group_id"]:
            raise AppError("请在原目标群继续邀请")
        sources = roster["source_ids"]
        roster_members = {member["qq"]: member for member in roster["members"]}
        selected = request.b("selected")
        if selected is not None and (not isinstance(selected, list) or any(
                not isinstance(qq, str) or qq not in roster_members for qq in selected)):
            raise AppError("部分勾选已不在跟踪计划中")
        recipients = list(roster_members) if selected is None else list(dict.fromkeys(selected))
        record = {"id": roster["id"], "delivery": {
            qq: member.get("delivery", "pending") for qq, member in roster_members.items()}}
    else:
        entry = results.STORE.get(owner, request.b("query_id", ""))
        sources, recipients = member_actions.selected_accounts(entry, request.b("selected"))

    def read(progress):
        plan = member_actions.preview(client, owner[1], session["adapter"], sources, recipients,
                                      request.body, progress, record)
        preview = results.STORE.create(owner, {"entity": "member_action", "items": []}, plan)
        return {**plan, "preview_id": preview["query_id"]}

    return _background(request, "核对成员操作范围", read)


def api_member_action_execute(request: Request):
    owner = _result_owner()
    client, _ = _active_client()
    key = request.b("preview_id", "")
    plan = results.STORE.plan(owner, key, "member_action")
    roster_id = plan["tracking_id"]
    create_tracking = plan["operation"] == "invite" and not roster_id
    track_only = request.b("track_only") is True
    if track_only:
        if not create_tracking:
            raise AppError("此预演无法新建入群跟踪计划")
    elif not plan["ready"] or plan["link_error"]:
        raise AppError("本次预演没有可执行的成员")
    if create_tracking:
        entry, actual = rosters._latest(client, owner[1], plan["group_id"], None)
    plan = results.STORE.plan(owner, key, "member_action", consume=True)
    if create_tracking:
        roster_id = rosters.create_invitation(owner[1], plan["group_name"], plan["group_id"], plan["source_ids"],
                                              [row["qq"] for row in plan["rows"]], entry, actual,
                                              pending_delivery="manual" if track_only else "pending")
    if track_only:
        return {"tracking_id": roster_id}
    task = jobs.MANAGER.submit(
        client, "member_action", member_actions.tasks(client, owner[1], plan, roster_id),
        title=f'{member_actions.LABELS[plan["operation"]]} · {plan["group_name"]}', interval=_interval(None),
        retries=0, meta={"group_id": plan["group_id"], "tracking_id": roster_id})
    return {"job": task, "tracking_id": roster_id}


# ------------------------------------------------------------------ 名单建群与入群跟踪
def api_rosters(request: Request):
    return {"rosters": rosters.list_rosters(_session()["login"]["user_id"])}


def api_roster_import(request: Request):
    draft = rosters.parse(request.body)
    return results.STORE.create(_result_owner(), rosters.build(draft, {}), {})


def api_roster_create(request: Request):
    return rosters.create(_session()["login"]["user_id"], request.body)


def api_roster_query(request: Request, roster_id: str):
    roster = rosters.load(_session()["login"]["user_id"], roster_id)
    return results.STORE.create(_result_owner(), rosters.build(roster, request.body), request.body)


def api_roster_bind(request: Request, roster_id: str):
    account_id = _session()["login"]["user_id"]
    client, _ = _active_client()
    return _background(request, "绑定群聊并核对入群名单", lambda progress:
                       rosters.bind(client, account_id, roster_id, request.b("group_id"), progress))


def api_roster_sync(request: Request, roster_id: str):
    account_id = _session()["login"]["user_id"]
    client, _ = _active_client()
    return _background(request, "核对最新入群名单", lambda progress:
                       rosters.sync(client, account_id, roster_id, progress))


def api_roster_delete(request: Request, roster_id: str):
    rosters.delete(_session()["login"]["user_id"], roster_id)
    return {"deleted": True}


def _members_compare(request, progress=None):
    sources = list(dict.fromkeys(str(gid) for gid in request.b("source_group_ids", [])))
    targets = list(dict.fromkeys(str(gid) for gid in request.b("target_group_ids", [])))
    if not sources or not targets:
        raise AppError("请选择名单来源群和待核对群")
    spec = {"entity": "memberships", "scope": {"group_ids": sources, "source_group_ids": targets,
             "show_remark": request.b("show_remark", True)}, "filter": request.b("source_filter"),
             "refresh": bool(request.b("refresh"))}
    dataset, pending = _query_data(spec, progress)
    if pending:
        return {"pending": True, "job": pending}
    if any(gid not in dataset["all_groups"] for gid in targets):
        raise AppError("部分待核对群已不在当前账号群列表中")
    return results.STORE.create(_result_owner(), comparison.build(dataset, request.body), request.body)


def api_fields(request: Request):
    from .core.filters import OPERATORS
    return {"fields": fields.FIELDS, "operators": OPERATORS,
            "group_columns": fields.GROUP_COLUMNS, "member_columns": fields.MEMBER_COLUMNS}


def api_query_export(request: Request):
    if request.b("query_id"):
        entry = results.STORE.get(_result_owner(), request.b("query_id"))
        result = entry["result"]
        entity = result.get("entity")
        matrix_key = entry["spec"].get("matrix_field", "member.card")
        matrix = result.get("matrix", False)
        if request.b("selected") is not None:
            chosen = set(request.b("selected"))
            result = {**result, "items": [item for item in result["items"] if item["id"] in chosen]}
    else:
        dataset, pending = _query_data(request.body)
        if pending:
            return {"pending": True, "job": pending}
        result = query.execute(dataset, request.body, paginate=False)
        entity = dataset["entity"]
        matrix_key = request.b("matrix_field", "member.card")
        matrix = entity == "people"
    definitions = {item["id"]: item for item in result["fields"]}
    columns = result["columns"]
    header = [definitions[key]["label"] for key in columns]
    rows = [[item["display"][key] for key in columns] for item in result["items"]]
    if entity == "people" and matrix:
        for group in result["groups"]:
            header.append(f'{definitions.get(matrix_key, {}).get("label", matrix_key)}·{group["name"]}（{group["group_id"]}）')
        for line, item in zip(rows, result["items"]):
            memberships = {entry["group_id"]: entry for entry in item["memberships"]}
            line.extend(memberships[group["group_id"]]["display"].get(matrix_key, "未提供")
                        if group["group_id"] in memberships else "未加入" for group in result["groups"])
    return _deliver(header, rows, "群务资料_" + time.strftime("%Y%m%d-%H%M"), request.b("format", "csv"))


def api_presets(request: Request):
    return presets.catalog(_config())


def api_save_preset(request: Request):
    with _LOCK:
        cfg = _config()
        saved = presets.save(cfg, request.body)
        config_mod.save(cfg)
    return {"preset": saved, **presets.catalog(cfg)}


def api_delete_preset(request: Request, preset_id: str):
    with _LOCK:
        cfg = _config()
        presets.delete(cfg, preset_id)
        config_mod.save(cfg)
    return presets.catalog(cfg)


def api_collect(request: Request):
    return _background(request, "准备资料补全范围", lambda progress: _collect(request, progress))


def _collect(request, progress=None):
    session = _session()
    client, _ = _active_client()
    spec = {"entity": "memberships", "scope": {"group_ids": request.b("group_ids") or []}}
    dataset = query.prepare(client, str(session["login"]["user_id"]), spec,
                            **({"on_progress": progress} if progress else {}))
    return {"job": collection.submit(client, dataset["entries"], dataset["ids"],
                                     retry_failed=bool(request.b("retry_failed")))}


def api_rename_preview(request: Request):
    return _background(request, "读取最新名单并预演群昵称", lambda progress: _rename_preview(request, progress))


def _rename_preview(request, progress=None):
    spec = request.b("query") or {}
    spec = {**spec, "refresh": True}
    dataset, pending = _query_data(spec, progress)
    if pending:
        return {"pending": True, "job": pending}
    return rename.preview(dataset, {**request.body, "query": spec}, str(_session()["login"]["user_id"]),
                          interval=_interval(request.b("interval")))


def api_rename_import(request: Request):
    text = request.b("text", "")
    if not isinstance(text, str):
        raise AppError("名单内容必须是 CSV 文本")
    result = {}
    for index, row in enumerate(csv.reader(io.StringIO(text.lstrip("\ufeff"))), 1):
        if not row or not any(row):
            continue
        if index == 1 and row[0].strip().lower() in ("qq", "qq号", "user_id"):
            continue
        if len(row) < 2 or not row[0].strip().isdigit() or not row[1].strip():
            raise AppError(f"名单第 {index} 行无效", hint="每行需要 QQ号、新群昵称 两列。")
        result[row[0].strip()] = row[1].strip()
    if not result:
        raise AppError("名单中没有有效成员")
    return {"mapping": result, "count": len(result)}


def api_preferences(request: Request):
    raw = request.b("batch") or {}
    batch = dict(_config().get("batch", {}))
    try:
        batch["interval"] = max(0.8, min(10, float(raw.get("interval", batch.get("interval", 2)))))
        batch["retries"] = max(0, min(5, int(raw.get("retries", batch.get("retries", 2)))))
        batch["trial_size"] = max(1, min(100, int(raw.get("trial_size", batch.get("trial_size", 10)))))
    except (TypeError, ValueError):
        raise AppError("运行参数格式错误")
    cfg = _config()
    cfg["batch"] = batch
    config_mod.save(cfg)
    return api_config(request)


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


def api_groups_load(request: Request):
    def read(progress):
        session = _session()
        client, _ = _active_client()
        self_id = str(session["login"]["user_id"])
        listing = groups.list_groups(client, self_id, force=bool(request.b("refresh")), on_progress=progress)
        if request.b("show_remark", True):
            remarks, _ = groups.fetch_remarks(client, self_id, [group["group_id"] for group in listing], on_progress=progress)
            listing = [{**group, "group_remark": remarks.get(group["group_id"]) or group.get("group_remark", "")} for group in listing]
        return {"groups": listing, "self": session["login"]}
    return _background(request, "读取群列表与群资料", read)


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


# ------------------------------------------------------------------ 跨群成员
def _cross_context(ids: list[str], *, force: bool = False, show_remark: bool = True):
    if not ids:
        raise AppError("请至少选择一个群")
    session = _session()
    client, _ = _active_client()
    all_groups = groups.list_groups(client, session["login"]["user_id"])
    group_map = {group["group_id"]: group for group in all_groups}
    missing = [gid for gid in ids if gid not in group_map]
    if missing:
        raise AppError("部分群已不在当前账号的群列表中", hint="群号：" + "、".join(missing) + "。请重新选群。")
    group_map = {gid: {**group_map[gid], "group_name":
                 (group_map[gid].get("group_remark") if show_remark else "") or group_map[gid]["group_name"]}
                 for gid in ids}
    entries, errors = members.fetch_many(client, ids, force=force)
    if errors:
        failed = "、".join(f'{group_map[gid]["group_name"]}（{gid}）' for gid in errors)
        raise AppError(f"有 {len(errors)} 个群拉取成员失败",
                       hint=f"失败的群：{failed}。本次结果未展示，请重试或重新选群。")
    return entries, group_map, session, client


def _common_options(values: dict) -> dict:
    return {
        "keyword": values.get("q", ""),
        "source_groups": _group_ids(values.get("source_groups", "")),
        "mode": values.get("mode", "all"),
        "in_groups": _group_ids(values.get("in_groups", "")),
        "not_in_groups": _group_ids(values.get("not_in_groups", "")),
        "status": values.get("status", "all"),
        "sort": values.get("sort", "count"),
        "selected": _group_ids(values["selected"]) if "selected" in values else None,
    }


def _common_context(request: Request) -> tuple[list[str], dict, dict, dict]:
    ids = _group_ids(request.q("groups"))
    entries, group_map, session, _ = _cross_context(
        ids, force=request.q("refresh") == "1", show_remark=request.q("show_remark", "1") != "0")
    names = {gid: group_map[gid]["group_name"] for gid in ids}
    return ids, entries, names, session


def api_members_common(request: Request):
    _, entries, names, _ = _common_context(request)
    try:
        page = max(1, int(request.q("page", "1")))
    except ValueError:
        raise AppError("页码必须是整数")
    return members.common_members(entries, names, page=page,
                                  **_common_options({key: value[0] for key, value in request.query.items()}))


def api_export_common(request: Request):
    ids, entries, names, _ = _common_context(request)
    result = members.common_members(entries, names, size=None,
                                   **_common_options({key: value[0] for key, value in request.query.items()}))
    fmt = request.q("format", "csv")

    header = ["QQ号", "QQ昵称", "所在群数", "参考群昵称", "来源群", "来源群昵称不同"]
    for group in result["groups"]:
        label = f"{group['group_name']}（{group['group_id']}）"
        header.extend([f"是否加入·{label}", f"群昵称·{label}", f"身份·{label}", f"加群时间·{label}"])

    rows: list[list[str]] = []
    for item in result["items"]:
        line = [item["qq"], item["nickname"], str(item["count"]), item["reference_card"],
                names.get(item["source_group_id"], ""), "是" if item["source_conflict"] else "否"]
        for group in result["groups"]:
            info = item["groups"].get(group["group_id"]) or {}
            line.extend(
                [
                    "已加入" if info else "未加入",
                    info.get("card") or "",
                    info.get("role_label") or "",
                    info.get("join_time") or "",
                ]
            )
        rows.append(line)

    stamp = time.strftime("%Y%m%d-%H%M")
    filename = f"跨群成员_{len(ids)}个群_{stamp}"
    return _deliver(header, rows, filename, fmt, sheet_title="跨群成员")


def _sync_ids(request: Request) -> tuple[list[str], list[str]]:
    def ids(key):
        value = request.b(key) or []
        if not isinstance(value, list):
            raise AppError("群列表格式错误")
        return list(dict.fromkeys(str(gid) for gid in value if gid))
    sources, targets = ids("source_group_ids"), ids("target_group_ids")
    if not sources or not targets:
        raise AppError("请选择基准群和目标群")
    if set(sources).intersection(targets):
        raise AppError("基准群只作为来源，请从目标群中移除重复的群")
    return sources, targets


def api_cards_sync_preview(request: Request):
    sources, targets = _sync_ids(request)
    entries, group_map, session, _ = _cross_context(
        sources + targets, force=True, show_remark=request.b("show_remark", True))
    options = _common_options(request.b("filters") or {})
    options["source_groups"] = sources
    result = members.common_members(entries, {gid: group["group_name"] for gid, group in group_map.items()},
                                    size=None, **options)
    if not result["items"]:
        raise AppError("当前范围没有成员", hint="调整筛选或重新勾选成员后预演。")
    return cards.preview_sync(result["items"], entries, group_map, targets, str(session["login"]["user_id"]),
                              only_empty=bool(request.b("only_empty")), interval=_interval(request.b("interval")))


def api_cards_sync_execute(request: Request):
    sources, targets = _sync_ids(request)
    reviewed = request.b("items")
    if not isinstance(reviewed, list) or not reviewed:
        raise AppError("请先预演并确认需要修改的群昵称")
    pairs = set()
    for item in reviewed:
        if (not isinstance(item, dict) or item.get("group_id") not in targets
                or not isinstance(item.get("qq"), str) or not item["qq"]
                or not isinstance(item.get("new_card"), str) or not item["new_card"].strip()
                or item.get("source_group_id") not in sources):
            raise AppError("预演内容不完整，请重新预演")
        pair = (item["group_id"], item["qq"])
        if pair in pairs:
            raise AppError("预演内容有重复目标，请重新预演")
        pairs.add(pair)
    return _execute_card_items(request, reviewed, targets)



def api_rename_execute(request: Request):
    reviewed = request.b("items")
    targets = request.b("target_group_ids")
    if not isinstance(reviewed, list) or not reviewed or not isinstance(targets, list) or not targets:
        raise AppError("请先预演群昵称修改")
    pairs = set()
    for item in reviewed:
        if (not isinstance(item, dict) or item.get("group_id") not in targets
                or not isinstance(item.get("qq"), str) or not item["qq"]
                or not isinstance(item.get("new_card"), str) or not item["new_card"].strip()):
            raise AppError("预演内容不完整，请重新预演")
        pair = (item["group_id"], item["qq"])
        if pair in pairs:
            raise AppError("预演内容有重复目标")
        pairs.add(pair)
    return _execute_card_items(request, reviewed, list(dict.fromkeys(targets)))

def _execute_card_items(request, reviewed, targets):
    mode = request.b("mode", "trial")
    if mode not in ("trial", "full"):
        raise AppError("执行模式无效")
    if mode == "trial":
        reviewed = reviewed[:int(_config().get("batch", {}).get("trial_size", 10))]
    elif len(reviewed) > 100 and not request.b("confirmed"):
        raise AppError(f"本次将修改 {len(reviewed)} 条群昵称", hint="超过 100 条需要二次确认。")

    # 执行只重查目标群；新群昵称取自预演，不随来源群后续变化而改变。
    entries, group_map, session, client = _cross_context(
        targets, force=True, show_remark=request.b("show_remark", True))
    interval = _interval(request.b("interval"))
    plan = cards.preview_sync([], entries, group_map, targets, str(session["login"]["user_id"]),
                              only_empty=bool(request.b("only_empty")), interval=interval, reviewed=reviewed)
    if not plan["items"]:
        raise AppError("没有可执行的修改", hint="目标成员或群昵称可能已变化，请重新预演。")
    snapshots, tasks = [], []
    title = f'{"试改" if mode == "trial" else "批量改"}群昵称 · {plan["stats"]["people"]} 人 / {len(plan["items"])} 条'
    for gid in targets:
        items = [item for item in plan["items"] if item["group_id"] == gid]
        if not items:
            continue
        snapshot = store.save_snapshot("cards", gid, {
            "group_name": group_map[gid]["group_name"],
            "members": [{"qq": item["qq"], "card": item["old_card"], "nickname": item["nickname"]}
                        for item in items],
        }, note=title)
        snapshots.append(snapshot)
        for task in cards.build_tasks(items, gid):
            task["label"] = f'{group_map[gid]["group_name"]} · {task["label"]}'
            tasks.append(task)
    job = jobs.MANAGER.submit(client, "card", tasks, title=title, interval=interval,
                              retries=int(_config().get("batch", {}).get("retries", 2)),
                              meta={"group_ids": targets, "snapshot_ids": [snap["id"] for snap in snapshots]})
    return {"job": job, "snapshots": snapshots, "planned": len(tasks), "skipped": plan["stats"]["skip"]}


# ------------------------------------------------------------------ 批量改群昵称
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
        raise AppError("没有需要修改的成员", hint="检查模板与作用范围，或成员群昵称本来就一致。")

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
        title = f"批量改群昵称 {len(items)} 人 · {ctx['group']['group_name']}"

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
    return _background(request, "预演各群设置差异", lambda progress: _settings_preview(request, progress))


def _settings_preview(request, progress=None):
    group_ids = list(dict.fromkeys(str(item) for item in (request.b("group_ids") or [])))
    if not group_ids:
        raise AppError("请至少选择一个群")
    template = request.b("template") or {}
    session = _session()
    client, _ = _active_client()
    self_id = str(session["login"]["user_id"])
    all_groups = groups.list_groups(client, self_id)
    targets = [groups.find(all_groups, gid) for gid in group_ids]
    adapter = adapters.get_adapter(session["adapter"])
    diff = groupsettings.build_diff(client, targets, template, session["capabilities"], adapter, self_id, progress)
    preview_id = uuid.uuid4().hex
    with _LOCK:
        # 预演只保留在内存；固定执行用户看过的目标值。
        now = time.time()
        for key in list(_SETTINGS_PREVIEWS):
            if now - _SETTINGS_PREVIEWS[key]["at"] > 1800:
                del _SETTINGS_PREVIEWS[key]
        if len(_SETTINGS_PREVIEWS) >= 20:
            del _SETTINGS_PREVIEWS[next(iter(_SETTINGS_PREVIEWS))]
        _SETTINGS_PREVIEWS[preview_id] = {"at": now, "namespace": client.cache_namespace,
                                          "adapter": session["adapter"], "group_ids": group_ids, "diff": diff}
    return {**diff, "preview_id": preview_id}


def api_settings_execute(request: Request):
    preview_id = request.b("preview_id") or ""
    with _LOCK:
        plan = _SETTINGS_PREVIEWS.get(preview_id)
    session = _session()
    client, _ = _active_client()
    if not plan or time.time() - plan["at"] > 1800 or plan["namespace"] != client.cache_namespace or plan["adapter"] != session["adapter"]:
        raise AppError("群设置预演已失效", hint="请重新预演并核对差异。")
    group_ids = plan["group_ids"]
    diff = plan["diff"]
    self_id = str(session["login"]["user_id"])
    adapter = adapters.get_adapter(session["adapter"])
    all_groups = groups.list_groups(client, self_id)
    targets = [groups.find(all_groups, gid) for gid in group_ids]
    task_list = groupsettings.build_tasks(diff["groups"], diff["template"])
    if not task_list:
        raise AppError("没有需要变更的设置", hint="模板内容与当前群设置一致，或接口不支持。")
    current = groupsettings.build_diff(client, targets, diff["template"], session["capabilities"], adapter, self_id)
    if groupsettings.build_tasks(current["groups"]) != task_list:
        raise AppError("群设置或管理员状态已变化", hint="请重新预演，核对最新差异后执行。")
    with _LOCK:
        if _SETTINGS_PREVIEWS.pop(preview_id, None) is None:
            raise AppError("本次预演已经提交", hint="请在任务中心查看执行进度。")

    snapshot = store.save_snapshot(
        "settings",
        "multi",
        {
            "group_name": "、".join(group["group_name"] for group in diff["groups"])[:60],
            "note": diff["template"]["name"],
            "entries": [
                {"group_id": group["group_id"], "group_name": group["group_name"], "fields": group["fields"]} for group in diff["groups"]
            ],
        },
        note=f"套用模板：{diff['template']['name']}",
    )

    job = jobs.MANAGER.submit(
        client,
        "settings",
        task_list,
        title=f"套用模板「{diff['template']['name']}」· {len(diff['groups'])} 个群",
        interval=_interval(request.b("interval")),
        retries=int(_config().get("batch", {}).get("retries", 2)),
        meta={"groups": group_ids, "snapshot_id": snapshot["id"]},
    )
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
        raise AppError("该快照不支持回滚", hint="只有改群昵称快照可以回滚。")
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
        title=f"回滚群昵称 · {snapshot.get('group_name') or group_id} · {len(task_list)} 人",
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
    raw = request.b("template") or {}
    template = groupsettings.normalize_template(raw)
    if raw.get("id"):
        template["id"] = str(raw["id"])
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
    router.add("POST", r"^/api/query$", api_query)
    router.add("POST", r"^/api/query/start$", api_query_start)
    router.add("GET", r"^/api/query/results/(?P<query_id>[a-f0-9]+)$", api_result_window)
    router.add("GET", r"^/api/query/results/(?P<query_id>[a-f0-9]+)/selection$", api_result_selection)
    router.add("GET", r"^/api/query/results/(?P<query_id>[a-f0-9]+)/position$", api_result_position)
    router.add("POST", r"^/api/members/compare$", api_members_compare)
    router.add("POST", r"^/api/members/match-roster$", api_match_roster)
    router.add("POST", r"^/api/members/match-roster/confirm$", api_match_roster_confirm)
    router.add("POST", r"^/api/members/match-roster/export$", api_match_roster_export)
    router.add("POST", r"^/api/members/actions/preview$", api_member_action_preview)
    router.add("POST", r"^/api/members/actions/execute$", api_member_action_execute)
    router.add("GET", r"^/api/rosters$", api_rosters)
    router.add("POST", r"^/api/rosters/import$", api_roster_import)
    router.add("POST", r"^/api/rosters$", api_roster_create)
    router.add("POST", r"^/api/rosters/(?P<roster_id>[a-f0-9]{32})/query$", api_roster_query)
    router.add("POST", r"^/api/rosters/(?P<roster_id>[a-f0-9]{32})/bind$", api_roster_bind)
    router.add("POST", r"^/api/rosters/(?P<roster_id>[a-f0-9]{32})/sync$", api_roster_sync)
    router.add("DELETE", r"^/api/rosters/(?P<roster_id>[a-f0-9]{32})$", api_roster_delete)
    router.add("POST", r"^/api/query/export$", api_query_export)
    router.add("GET", r"^/api/fields$", api_fields)
    router.add("GET", r"^/api/filter-presets$", api_presets)
    router.add("POST", r"^/api/filter-presets$", api_save_preset)
    router.add("DELETE", r"^/api/filter-presets/(?P<preset_id>[^/]+)$", api_delete_preset)
    router.add("POST", r"^/api/data/collect$", api_collect)
    router.add("POST", r"^/api/rename/preview$", api_rename_preview)
    router.add("POST", r"^/api/rename/execute$", api_rename_execute)
    router.add("POST", r"^/api/rename/import$", api_rename_import)
    router.add("GET", r"^/api/config$", api_config)
    router.add("POST", r"^/api/config/profile$", api_save_profile)
    router.add("POST", r"^/api/config/preferences$", api_preferences)
    router.add("POST", r"^/api/connect$", api_connect)
    router.add("GET", r"^/api/capabilities$", api_capabilities)

    router.add("GET", r"^/api/groups$", api_groups)
    router.add("POST", r"^/api/groups/load$", api_groups_load)
    router.add("GET", r"^/api/groups/remarks$", api_group_remarks)
    router.add("GET", r"^/api/groups/(?P<gid>[^/]+)/members$", api_members)
    router.add("GET", r"^/api/groups/(?P<gid>[^/]+)/export$", api_export)

    router.add("GET", r"^/api/export/groups$", api_export_groups)
    router.add("GET", r"^/api/members/common$", api_members_common)
    router.add("GET", r"^/api/export/common$", api_export_common)

    router.add("POST", r"^/api/cards/preview$", api_cards_preview)
    router.add("POST", r"^/api/cards/execute$", api_cards_execute)
    router.add("POST", r"^/api/cards/sync/preview$", api_cards_sync_preview)
    router.add("POST", r"^/api/cards/sync/execute$", api_cards_sync_execute)

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
