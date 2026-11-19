"""群设置：规范化模板、只读预演和协议任务构建。"""
from __future__ import annotations

import re

from ..core import template as tpl
from ..core.errors import AppError
from ..onebot.adapters import action

ADD_MODES = {
    "open": (1, "允许任何人加群"),
    "approve": (2, "需要发送验证消息"),
    "closed": (3, "不允许任何人加群"),
    "question": (4, "正确回答问题自动加入"),
    "question_approve": (5, "回答问题并由管理员审核"),
}
INVITE_POLICIES = {
    "disabled": "禁止群成员邀请好友",
    "require_approval": "允许邀请，需管理员审核",
    "no_approval": "允许邀请，无需审核",
    "no_approval_under_100": "允许邀请，群人数少于 100 时无需审核",
}
KICK_LIMITS = (0, 5, 10, 20, 50, 100, 200)
PERMISSION_LABELS = {"receive_verify": "接收验证消息", "recall_member_message": "撤回成员消息", "kick_member": "移除群成员"}
UNKNOWN = "（当前状态未知）"


def group_add_option(info):
    return info.get("groupOption", info.get("add_type"))


def _choice(value, choices, label):
    value = value or "keep"
    if value not in choices:
        raise AppError(f"{label}选项无效")
    return value


def normalize_template(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise AppError("群设置模板格式无效")
    add = raw.get("add_option") or {}
    admin = raw.get("admin") or {}
    if not isinstance(add, dict) or not isinstance(admin, dict):
        raise AppError("加群方式或管理员设置格式无效")
    mode = _choice(add.get("mode"), {"keep", *ADD_MODES}, "加群方式")
    question = str(add.get("question") or "").strip() if mode in ("question", "question_approve") else ""
    answer = str(add.get("answer") or "").strip() if mode == "question" else ""
    if mode in ("question", "question_approve") and not question:
        raise AppError("请填写验证问题")
    if mode == "question" and not answer:
        raise AppError("正确回答问题自动加入时必须填写答案")
    admin_mode = _choice(admin.get("mode"), ("keep", "add", "remove", "permissions"), "管理员操作")
    target = admin.get("target") or "specified"
    if target not in ("specified", "all", "owner"):
        raise AppError("管理员目标范围无效")
    raw_ids = admin.get("user_ids") or []
    if admin_mode == "keep" or admin_mode == "permissions" and target in ("all", "owner"):
        raw_ids = []
    if isinstance(raw_ids, str):
        raw_ids = re.split(r"[\s,，;；]+", raw_ids.strip())
    if not isinstance(raw_ids, list):
        raise AppError("请填写管理员 QQ 号")
    ids = list(dict.fromkeys(str(qq).strip() for qq in raw_ids if str(qq).strip()))
    if any(not re.fullmatch(r"[1-9][0-9]*", qq) for qq in ids):
        raise AppError("管理员 QQ 号只能填写正整数，多个 QQ 用逗号或换行分隔")
    permissions = {}
    source = admin.get("permissions") or {}
    if not isinstance(source, dict):
        raise AppError("管理员权限格式无效")
    for key, label in PERMISSION_LABELS.items():
        permissions[key] = _choice(source.get(key), ("keep", "on", "off"), label) if admin_mode == "permissions" else "keep"
    if target == "owner":
        permissions.update(recall_member_message="keep", kick_member="keep")
    limit = 0
    if permissions["kick_member"] == "on":
        value = source.get("kick_member_per_day", 0)
        if isinstance(value, bool) or str(value) not in {str(n) for n in KICK_LIMITS}:
            raise AppError("每日可移除人数必须为不限、5、10、20、50、100 或 200")
        limit = int(value)
    permissions["kick_member_per_day"] = limit
    if admin_mode != "keep" and (admin_mode != "permissions" or target == "specified") and not ids:
        raise AppError("请至少填写一个管理员 QQ 号")
    if admin_mode == "permissions" and all(permissions[key] == "keep" for key in PERMISSION_LABELS):
        raise AppError("请至少选择一项管理员权限变更")
    return {
        "name": str(raw.get("name") or "未命名模板").strip() or "未命名模板",
        "group_name": str(raw.get("group_name") or "").strip(),
        "notice": str(raw.get("notice") or "").strip(),
        "portrait": str(raw.get("portrait") or "").strip(),
        "whole_ban": _choice(raw.get("whole_ban"), ("keep", "on", "off"), "全员禁言"),
        "search_option": _choice(raw.get("search_option"), ("keep", "on", "off"), "群号搜索"),
        "add_option": {"mode": mode, "question": question, "answer": answer},
        "invite_policy": _choice(raw.get("invite_policy"), {"keep", *INVITE_POLICIES}, "邀请权限"),
        "admin": {"mode": admin_mode, "target": target if admin_mode == "permissions" else "specified",
                  "user_ids": ids if admin_mode != "keep" else [], "permissions": permissions},
    }


def _read(client, action_name, **params):
    try:
        return client.call(action_name, timeout=15, **params) or {}, ""
    except AppError as exc:
        return {}, exc.message


def _switch(value):
    if value is None:
        return UNKNOWN
    return "开启" if value else "关闭"


def _limit(value):
    return UNKNOWN if value is None else "不限" if value == 0 else f"{value} 人／日"


def _member_fields(client, gid, template, caps, adapter, role):
    admin = template["admin"]
    if admin["mode"] == "keep":
        return []
    fields = []
    mode = admin["mode"]
    roster, error = _read(client, "get_group_member_list", group_id=gid, no_cache=True)
    roster = roster if isinstance(roster, list) else []
    by_id = {str(m.get("user_id")): m for m in roster if isinstance(m, dict)}
    if admin["target"] in ("all", "owner"):
        target_role = "owner" if admin["target"] == "owner" else "admin"
        ids = sorted(qq for qq, m in by_id.items() if m.get("role") == target_role)
    else:
        ids = admin["user_ids"]
    if not ids:
        return [{"key": "admin", "label": "管理员", "from": "", "to": "", "supported": False,
                 "changed": False, "note": error or "未找到目标群主或管理员"}]
    for qq in ids:
        member = by_id.get(qq)
        member_role = (member or {}).get("role")
        who = f"{(member or {}).get('card') or (member or {}).get('nickname') or qq}（{qq}）"
        blocked = error or ("当前账号不是群主" if role != "owner" else "")
        if not member and not blocked:
            blocked = "该 QQ 未加入本群"
        if mode in ("add", "remove"):
            note = blocked or ("不能更改群主身份" if member_role == "owner" else "")
            changed = member_role != ("admin" if mode == "add" else "member")
            supported = bool(caps.get("admin") and action(adapter, "admin"))
            fields.append({"key": "admin", "label": f"管理员 · {who}",
                           "from": {"owner": "群主", "admin": "管理员", "member": "普通成员"}.get(member_role, UNKNOWN),
                           "to": "设为管理员" if mode == "add" else "取消管理员",
                           "supported": supported and not note, "changed": changed,
                           "note": note or ("" if supported else "当前协议端不支持管理员操作"),
                           "task": {"action": action(adapter, "admin"), "params": {"group_id": gid, "user_id": qq, "enable": mode == "add"}}})
            continue
        if member_role != "admin" and not (member_role == "owner" and admin["target"] == "owner") and not blocked:
            blocked = "仅可设置现有管理员的权限，请先添加管理员并等待任务完成"
        requested = admin["permissions"]
        needs_permissions = any(requested[k] != "keep" for k in ("recall_member_message", "kick_member"))
        can_permissions = bool(caps.get("admin_permissions") and action(adapter, "admin_permissions"))
        can_verify = bool(caps.get("admin_receive_verify") and action(adapter, "admin_receive_verify"))
        current, read_error = {}, ""
        if not blocked and ((needs_permissions and can_permissions) or (requested["receive_verify"] != "keep" and can_verify)):
            current, read_error = _read(client, action(adapter, "admin_permissions_read"), group_id=gid, user_id=qq)
        blocked = blocked or (f"读取管理员权限失败：{read_error}" if read_error else "")
        if needs_permissions:
            params = {"group_id": gid, "user_id": qq}
            old, new = [], []
            for key in ("recall_member_message", "kick_member"):
                if requested[key] == "keep":
                    continue
                target = requested[key] == "on"
                old.append(f"{PERMISSION_LABELS[key]}：{_switch(current.get(key))}")
                new.append(f"{PERMISSION_LABELS[key]}：{_switch(target)}")
                if key == "kick_member" and target:
                    old[-1] += f"（{_limit(current.get('kick_member_per_day'))}）"
                    new[-1] += f"（{_limit(requested['kick_member_per_day'])}）"
                if current.get(key) != target or (key == "kick_member" and target and current.get("kick_member_per_day") != requested["kick_member_per_day"]):
                    params[key] = target
                    if key == "kick_member" and target:
                        params["kick_member_per_day"] = requested["kick_member_per_day"]
            fields.append({"key": "admin_permissions", "label": f"管理员权限 · {who}", "from": "；".join(old), "to": "；".join(new),
                           "supported": can_permissions and not blocked, "changed": len(params) > 2,
                           "note": blocked or ("" if can_permissions else "当前协议端未提供细分权限接口；需支持此接口的 SnowLuma"),
                           "task": {"action": action(adapter, "admin_permissions"), "params": params}})
        if requested["receive_verify"] != "keep":
            target = requested["receive_verify"] == "on"
            fields.append({"key": "admin_receive_verify", "label": f"验证消息 · {who}", "from": _switch(current.get("receive_verify")), "to": _switch(target),
                           "supported": can_verify and not blocked, "changed": current.get("receive_verify") != target,
                           "note": blocked or ("" if can_verify else "当前协议端未提供验证消息权限接口；需支持此接口的 SnowLuma"),
                           "task": {"action": action(adapter, "admin_receive_verify"), "params": {"group_id": gid, "user_id": qq, "enable": target}}})
    return fields


def build_diff(client, groups: list[dict], raw_template: dict, caps: dict, adapter: dict, self_id: str = "", on_progress=None) -> dict:
    template = normalize_template(raw_template)
    if not any([template[k] for k in ("group_name", "notice", "portrait")]) and not any([
        template["whole_ban"] != "keep", template["search_option"] != "keep", template["add_option"]["mode"] != "keep",
        template["invite_policy"] != "keep", template["admin"]["mode"] != "keep",
    ]):
        raise AppError("模板是空的", hint="至少选择一项要修改的群设置。")
    unknown = sorted(set(tpl.VAR_RE.findall(template["group_name"]) + tpl.VAR_RE.findall(template["notice"])) - {"group_name", "group_id"})
    warnings = ["未知的群设置变量会原样保留：" + "、".join("{%s}" % v for v in unknown)] if unknown else []
    result = []
    for index, group in enumerate(groups):
        if on_progress:
            on_progress("读取各群设置与管理员", index, len(groups))
        gid = str(group["group_id"])
        info, info_error = _read(client, "get_group_info", group_id=gid, no_cache=True)
        current_name = info.get("group_name") or group.get("group_name") or gid
        role = group.get("my_role") or ""
        role_error = ""
        if self_id:
            own, role_error = _read(client, "get_group_member_info", group_id=gid, user_id=str(self_id), no_cache=True)
            role = own.get("role", "")
        blocked = (f"无法确认当前账号身份：{role_error}" if role_error else "") or ("当前账号不是群主或管理员" if role not in ("owner", "admin") else "")
        detail = {}
        if any([template["whole_ban"] != "keep", template["search_option"] != "keep", template["add_option"]["mode"] != "keep", template["invite_policy"] != "keep"]):
            detail, _ = _read(client, "get_group_detail_info", group_id=gid)
        fields = []

        def add(key, label, old, new, action_name, params, *, changed=True, capability=None, note=""):
            supported = bool(action_name) and (caps.get(capability, False) if capability else True)
            fields.append({"key": key, "label": label, "from": old, "to": new, "changed": changed,
                           "supported": supported and not blocked,
                           "note": blocked or (f"当前协议端不支持{label}" if not supported else note),
                           "task": {"action": action_name, "params": {"group_id": gid, **params}}})

        context = {"group_name": current_name, "group_id": gid}
        if template["group_name"]:
            target, clamped = tpl.clamp(tpl.render(template["group_name"], context), tpl.GROUP_NAME_MAX_LEN)
            add("group_name", "群名称", current_name, target, "set_group_name", {"group_name": target},
                changed=target != current_name, note="超长已截断" if clamped else info_error)
        if template["notice"]:
            content = tpl.render(template["notice"], context)
            # 发布新公告是新增操作，不把“最新一条公告”误当成整个公告内容。
            add("notice", "发布群公告", "新增一条公告", content, action(adapter, "notice_write"), {"content": content}, capability="notice")
        if template["portrait"]:
            add("portrait", "群头像", "（当前头像）", template["portrait"], action(adapter, "portrait"), {"file": template["portrait"]}, capability="portrait")
        if template["whole_ban"] != "keep":
            current = detail.get("group_all_shut")
            old = bool(current) if current is not None else None
            target = template["whole_ban"] == "on"
            add("whole_ban", "全员禁言", _switch(old), _switch(target), "set_group_whole_ban", {"enable": target}, changed=old != target)
        if template["add_option"]["mode"] != "keep":
            value = template["add_option"]
            number, label = ADD_MODES[value["mode"]]
            current = group_add_option(detail)
            old = next((text for code, text in ADD_MODES.values() if code == current), UNKNOWN)
            params = {"add_type": number}
            changed = current != number
            if number in (4, 5):
                params["group_question"] = value["question"]
                old += f"；问题：{detail.get('groupQuestion', detail.get('group_question', UNKNOWN))}"
                label += f"；问题：{value['question']}"
                changed |= detail.get("groupQuestion", detail.get("group_question")) != value["question"]
            if number == 4:
                params["group_answer"] = value["answer"]
                old += f"；答案：{detail.get('groupAnswer', detail.get('group_answer', UNKNOWN))}"
                label += f"；答案：{value['answer']}"
                changed |= detail.get("groupAnswer", detail.get("group_answer")) != value["answer"]
            add("add_option", "加群方式", old, label, action(adapter, "add_option"), params, changed=changed, capability="add_option")
        if template["invite_policy"] != "keep":
            current = detail.get("member_invite_policy")
            if current is None and detail.get("privilegeFlag") is not None:
                flags = int(detail["privilegeFlag"])
                current = "disabled" if flags & 0x04000000 else "no_approval" if flags & 0x00100000 else "no_approval_under_100" if flags & 0x02000000 else "require_approval"
            value = template["invite_policy"]
            add("invite_policy", "成员邀请权限", INVITE_POLICIES.get(current, UNKNOWN), INVITE_POLICIES[value], action(adapter, "invite_policy"), {"policy": value}, changed=current != value, capability="invite_policy")
        if template["search_option"] != "keep":
            value = template["search_option"] == "on"
            add("search_option", "通过群号搜索", UNKNOWN, "允许" if value else "禁止", action(adapter, "search_option"),
                {"no_code_finger_open": 1 if value else 2}, capability="search_option", note="扩展接口，效果取决于协议端版本")
        fields.extend(_member_fields(client, gid, template, caps, adapter, role))
        actionable = sum(bool(f["supported"] and f["changed"]) for f in fields)
        result.append({"group_id": gid, "group_name": current_name, "my_role": role, "fields": fields,
                       "actionable": actionable, "skipped": sum(not f["supported"] for f in fields)})
        if on_progress:
            on_progress("读取各群设置与管理员", index + 1, len(groups))
    return {"template": template, "groups": result, "total_changes": sum(g["actionable"] for g in result),
            "warnings": warnings, "skipped": sum(g["skipped"] for g in result)}


def build_tasks(diff_groups: list[dict], template: dict | None = None) -> list[dict]:
    return [{"target": str(group["group_id"]), "label": f"{group['group_name']} · {field['label']}", **field["task"]}
            for group in diff_groups for field in group["fields"] if field["supported"] and field["changed"]]
