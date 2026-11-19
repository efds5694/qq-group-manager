"""导入导出名单，保存建群计划，并用最新群成员名单跟踪入群情况。"""
from __future__ import annotations

import base64
import binascii
import csv
import io
import re
import threading
import time
import uuid
from pathlib import Path

from ..core import fields, store
from ..core.errors import AppError
from . import members

_LOCK = threading.RLock()
_DELIVERING = set()
QQ_HEADERS = {"qq号", "qq", "user_id", "member.qq"}
STATUS = {"joined": "已入群", "missing": "未入群", "left": "已退群", "unknown": "待核对"}
TRACKING_FIELDS = [
    fields.field("roster.status", "入群状态"),
    fields.field("roster.current_nickname", "当前昵称"),
    fields.field("roster.current_card", "当前群昵称"),
    fields.field("roster.join_time", "本次加群时间", "datetime"),
    fields.field("roster.first_seen", "首次确认入群", "datetime"),
    fields.field("roster.last_seen", "最后确认在群", "datetime"),
    fields.field("roster.checked_at", "最近核对时间", "datetime"),
    fields.field("roster.group_id", "目标群号"),
    fields.field("roster.group_name", "目标群名称"),
]


def _cell(value):
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value if value is not None else "").strip()


def _read_rows(payload):
    filename = str(payload.get("filename") or "").lower()
    if payload.get("file_base64") is not None:
        try:
            raw = base64.b64decode(payload["file_base64"], validate=True)
        except (ValueError, TypeError, binascii.Error):
            raise AppError("名单文件内容无效")
        if filename.endswith(".xlsx"):
            try:
                from openpyxl import load_workbook
            except ImportError:
                raise AppError("未安装 openpyxl，无法导入 XLSX", hint="安装 requirements-xlsx.txt，或使用 CSV／复制表格。")
            try:
                workbook = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
                try:
                    return [list(row) for row in workbook.active.iter_rows(values_only=True)]
                finally:
                    workbook.close()
            except Exception:
                raise AppError("无法读取 XLSX 名单", hint="请使用本工具导出的 XLSX 文件，或另存为 CSV。")
        if not filename.endswith((".csv", ".tsv", ".txt", ".md")):
            raise AppError("不支持的名单格式", hint="请选择 CSV、TSV 或 XLSX 文件。")
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise AppError("名单文件不是 UTF-8 编码", hint="请使用本工具导出的 CSV，或在 Excel 中另存为 UTF-8 CSV。")
    else:
        text = payload.get("text", "")
    if not isinstance(text, str) or not text.strip():
        raise AppError("请选择名单文件或粘贴表格内容")
    text = text.lstrip("\ufeff")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) > 1 and "|" in lines[0]:
        def markdown_cells(line):
            return [part.replace(r"\|", "|").strip() for part in
                    re.split(r"(?<!\\)\|", line.removeprefix("|").removesuffix("|"))]
        divider = markdown_cells(lines[1])
        if divider and all(re.fullmatch(r":?-{2,}:?", cell) for cell in divider):
            return [markdown_cells(line) for index, line in enumerate(lines) if index != 1]
    try:
        dialect = csv.Sniffer().sniff(text[:8192], delimiters=",\t")
        delimiter = dialect.delimiter
    except csv.Error:
        delimiter = "\t" if "\t" in text.splitlines()[0] else ","
    try:
        return list(csv.reader(io.StringIO(text, newline=""), delimiter=delimiter, strict=True))
    except csv.Error as exc:
        raise AppError("名单表格格式无效", hint=str(exc))


def parse(payload):
    rows = _read_rows(payload)
    nonempty = [(index, [_cell(cell) for cell in row]) for index, row in enumerate(rows, 1)
                if any(_cell(cell) for cell in row)]
    if not nonempty:
        raise AppError("名单中没有有效成员")
    header = nonempty[0][1]
    qq_columns = [index for index, label in enumerate(header) if label.lower() in QQ_HEADERS]
    if len(qq_columns) != 1:
        raise AppError("名单需要一列 QQ号", hint="保留导出表头中的“QQ号”列，其他列及列顺序可以不变。")
    qq_index = qq_columns[0]
    roster = {}
    duplicates = 0
    for line, row in nonempty[1:]:
        if len(row) > len(header):
            raise AppError(f"名单第 {line} 行列数超过表头", hint="请检查逗号、制表符或引号。")
        row += [""] * (len(header) - len(row))
        qq = row[qq_index]
        if not re.fullmatch(r"[0-9]+", qq) or int(qq) == 0:
            raise AppError(f"名单第 {line} 行 QQ号无效", hint="QQ号必须是完整数字，不能是科学计数法。")
        qq = str(int(qq))
        row[qq_index] = qq
        if qq in roster:
            duplicates += 1
            previous = roster[qq]["cells"]
            roster[qq]["cells"] = [old or new for old, new in zip(previous, row)]
        else:
            roster[qq] = {"qq": qq, "cells": row, "present": None,
                          "first_seen": None, "last_seen": None}
    if not roster:
        raise AppError("名单中没有有效成员")
    return {"header": header, "qq_index": qq_index, "members": list(roster.values()), "duplicates": duplicates}


def _directory(account_id) -> Path:
    account_id = str(account_id)
    if not re.fullmatch(r"[0-9]+", account_id):
        raise AppError("请先连接 QQ账号")
    return store.DATA_DIR / "rosters" / account_id


def _path(account_id, roster_id):
    if not re.fullmatch(r"[a-f0-9]{32}", str(roster_id)):
        raise AppError("建群名单不存在", status=404)
    return _directory(account_id) / f"{roster_id}.json"


def load(account_id, roster_id):
    with _LOCK:
        roster = store.read_json(_path(account_id, roster_id))
        if not roster:
            raise AppError("建群名单不存在", status=404)
        return roster


def _status(member):
    if member["present"] is None:
        return "unknown"
    return "joined" if member["present"] else "left" if member.get("first_seen") else "missing"


def summary(roster):
    counts = {key: 0 for key in STATUS}
    for member in roster["members"]:
        counts[_status(member)] += 1
    return {key: roster.get(key) for key in ("id", "name", "group_id", "group_name", "created_at", "checked_at", "last_error")} | {
        "count": len(roster["members"]), "duplicates": roster["duplicates"], **counts,
        "not_joined": counts["missing"] + counts["left"], "invitation": bool(roster.get("source_ids")),
    }


def list_rosters(account_id):
    with _LOCK:
        listing = [summary(data) for path in _directory(account_id).glob("*.json")
                   if (data := store.read_json(path))]
    return sorted(listing, key=lambda item: item["created_at"], reverse=True)


def create(account_id, payload):
    name = str(payload.get("name") or "").strip()
    if not name:
        raise AppError("请填写建群计划名称")
    roster = {**parse(payload), "id": uuid.uuid4().hex, "name": name,
              "group_id": "", "group_name": "", "created_at": time.time(), "checked_at": None, "last_error": ""}
    with _LOCK:
        store.write_json(_path(account_id, roster["id"]), roster)
    return summary(roster)


def delete(account_id, roster_id):
    with _LOCK:
        load(account_id, roster_id)
        _path(account_id, roster_id).unlink()


DELIVERY = {"pending": "待发送", "already": "原已在群", "sending": "结果未知",
            "sent": "已发送", "manual": "待手动处理", "unknown": "结果未知"}


def create_invitation(account_id, name, group_id, source_ids, recipients, entry, actual, *, pending_delivery="pending"):
    roster = {"id": uuid.uuid4().hex, "name": name, "group_id": group_id, "group_name": name,
              "source_ids": source_ids, "header": ["QQ号"], "qq_index": 0, "duplicates": 0,
              "created_at": time.time(), "members": [
                  {"qq": qq, "cells": [qq], "first_seen": None, "last_seen": None,
                   "delivery": "already" if qq in actual else pending_delivery} for qq in recipients]}
    _update(roster, entry, actual)
    with _LOCK:
        store.write_json(_path(account_id, roster["id"]), roster)
    return roster["id"]


def record_delivery(account_id, roster_id, group_id, qq, status):
    with _LOCK:
        roster = load(account_id, roster_id)
        if roster["group_id"] != group_id:
            raise AppError("目标群已变更，请重新预演邀请")
        member = next(item for item in roster["members"] if item["qq"] == qq)
        member["delivery"] = status
        store.write_json(_path(account_id, roster_id), roster)


def claim_delivery(account_id, roster_id, group_id, qq):
    key = (account_id, roster_id, qq)
    with _LOCK:
        roster = load(account_id, roster_id)
        member = next(item for item in roster["members"] if item["qq"] == qq)
        if key in _DELIVERING or member.get("delivery") == "sent":
            return False
        record_delivery(account_id, roster_id, group_id, qq, "sending")
        _DELIVERING.add(key)
        return True


def finish_delivery(account_id, roster_id, group_id, qq, status):
    with _LOCK:
        try:
            record_delivery(account_id, roster_id, group_id, qq, status)
        finally:
            _DELIVERING.discard((account_id, roster_id, qq))


def _latest(client, account_id, group_id, progress):
    if progress:
        progress("读取最新群成员名单", 0, 1)
    entry = members.fetch(client, group_id, force=True)
    actual = {member["qq"]: member for member in entry["members"]}
    if str(account_id) not in actual or any(not re.fullmatch(r"[0-9]+", qq) for qq in actual):
        raise AppError("未取得当前账号的完整群成员名单", hint="请确认当前账号仍在群内，重试核对；此次不更新入群状态。")
    if progress:
        progress("核对名单并保存入群进度", 1, 1)
    return entry, actual


def _update(roster, entry, actual):
    checked = entry["fetched_at"]
    for member in roster["members"]:
        current = actual.get(member["qq"])
        member["present"] = current is not None
        if current is not None:
            member["first_seen"] = member.get("first_seen") or checked
            member["last_seen"] = checked
        if not roster.get("source_ids"):
            member["current_nickname"] = (current or {}).get("nickname", "")
            member["current_card"] = (current or {}).get("card", "")
        member["join_time"] = (current or {}).get("join_ts")
    roster.update(checked_at=checked, last_error="")


def bind(client, account_id, roster_id, group_id, progress=None):
    group_id = str(group_id or "").strip()
    if not re.fullmatch(r"[0-9]+", group_id) or int(group_id) == 0:
        raise AppError("请填写有效群号")
    original = load(account_id, roster_id)
    if original.get("source_ids") and group_id != original["group_id"]:
        raise AppError("邀请记录绑定原目标群，请为其他群创建新计划")
    info = client.call("get_group_info", group_id=group_id, no_cache=True) or {}
    entry, actual = _latest(client, account_id, group_id, progress)
    with _LOCK:
        roster = load(account_id, roster_id)
        if roster["group_id"] != original["group_id"]:
            raise AppError("目标群已变更，请重新打开绑定窗口")
        if roster["group_id"] != group_id:
            for member in roster["members"]:
                member.update(first_seen=None, last_seen=None)
        roster.update(group_id=group_id, group_name=info.get("group_name") or group_id)
        _update(roster, entry, actual)
        store.write_json(_path(account_id, roster_id), roster)
    return summary(roster)


def sync(client, account_id, roster_id, progress=None):
    original = load(account_id, roster_id)
    group_id = original["group_id"]
    if not group_id:
        raise AppError("请先绑定 QQ群")
    try:
        entry, actual = _latest(client, account_id, group_id, progress)
    except AppError as exc:
        with _LOCK:
            roster = load(account_id, roster_id)
            if roster["group_id"] == group_id:
                roster["last_error"] = exc.message
                store.write_json(_path(account_id, roster_id), roster)
        raise
    with _LOCK:
        roster = load(account_id, roster_id)
        if roster["group_id"] != group_id:
            raise AppError("目标群已变更，请重新核对")
        if entry["fetched_at"] >= (roster["checked_at"] or 0):
            _update(roster, entry, actual)
            store.write_json(_path(account_id, roster_id), roster)
    return summary(roster)


def build(roster, spec):
    status = spec.get("status", "all")
    if status not in (*STATUS, "all", "not_joined", "manual"):
        raise AppError("入群状态筛选无效")
    text = str(spec.get("search") or "").strip().casefold()
    imported = [fields.field("member.qq" if index == roster["qq_index"] else f"roster.column.{index}", label or f"第{index+1}列")
                for index, label in enumerate(roster["header"])]
    definitions = imported + TRACKING_FIELDS
    if roster.get("source_ids"):
        definitions = [item for item in definitions if item["id"] not in ("roster.current_nickname", "roster.current_card")]
        definitions.append(fields.field("roster.delivery", "发送状态"))
    items = []
    for member in roster["members"]:
        state = _status(member)
        delivery = member.get("delivery", "pending")
        if status == "manual":
            if delivery not in ("manual", "unknown", "sending") or state == "joined":
                continue
        elif (status == "not_joined" and state not in ("missing", "left")
              or status not in ("all", "not_joined", state)):
            continue
        values = {definition["id"]: value for definition, value in zip(imported, member["cells"])}
        values.update({"roster.status": STATUS[state], "roster.checked_at": roster.get("checked_at"),
                       "roster.group_id": roster.get("group_id", ""), "roster.group_name": roster.get("group_name", "")})
        if roster.get("source_ids"):
            values["roster.delivery"] = DELIVERY[delivery]
        values.update({f"roster.{key}": member.get(key, "") for key in
                       ("current_nickname", "current_card", "join_time", "first_seen", "last_seen")})
        display = {definition["id"]: fields.display(values.get(definition["id"]), definition) for definition in definitions}
        if text and not any(text in value.casefold() for value in display.values()):
            continue
        items.append({"id": member["qq"], "qq": member["qq"], "status": state, "values": values, "display": display})
    sort = spec.get("sort") or {"field": "member.qq", "desc": False}
    key = sort.get("field")
    if key not in {definition["id"] for definition in definitions}:
        raise AppError("名单排序字段无效")
    items.sort(key=lambda item: int(item["qq"]) if key == "member.qq" else item["display"][key], reverse=bool(sort.get("desc")))
    # 状态紧跟 QQ号，导出保留原始名单的全部字段。
    columns = ["member.qq", "roster.status"] + [definition["id"] for definition in imported if definition["id"] != "member.qq"]
    columns += [definition["id"] for definition in definitions[len(imported):]
                if definition["id"] not in ("roster.status", "roster.delivery")]
    if roster.get("source_ids"):
        columns.insert(2, "roster.delivery")
    return {"entity": "roster", "items": items, "total": len(items), "columns": columns, "fields": definitions,
            "groups": [], "data_at": roster.get("checked_at"), "roster": summary(roster)}
