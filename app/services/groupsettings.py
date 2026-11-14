"""群设置模板：逐群差异计算 + 任务构建。

能读到当前值的字段（群名、公告）做真实差异对比；
读不到当前值的字段（全员禁言、头像、加群选项、搜索）只提示「将设置为什么」。
"""

from __future__ import annotations

from ..core import template as tpl
from ..onebot.adapters import action
from ..core.errors import AppError

FIELD_LABELS = {
    "group_name": "群名称",
    "notice": "群公告",
    "whole_ban": "全员禁言",
    "portrait": "群头像",
    "add_option": "加群方式",
    "search_option": "群搜索",
}


def _current_group_info(client, group_id: str) -> dict:
    try:
        return client.call("get_group_info", group_id=group_id, timeout=15) or {}
    except AppError:
        return {}


def _current_notice(client, group_id: str, adapter: dict) -> str:
    read_action = action(adapter, "notice_read")
    if not read_action:
        return ""
    try:
        notices = client.call(read_action, group_id=group_id, timeout=15) or []
    except AppError:
        return ""
    if isinstance(notices, list) and notices:
        latest = notices[0] if isinstance(notices[0], dict) else {}
        return str(latest.get("text") or latest.get("content") or "").strip()
    return ""


def normalize_template(raw: dict) -> dict:
    add_option = raw.get("add_option") or {}
    return {
        "name": (raw.get("name") or "未命名模板").strip(),
        "group_name": (raw.get("group_name") or "").strip(),
        "notice": (raw.get("notice") or "").strip(),
        "whole_ban": raw.get("whole_ban") or "keep",  # keep / on / off
        "portrait": (raw.get("portrait") or "").strip(),
        "add_option": {
            "mode": add_option.get("mode") or "keep",  # keep / open / question
            "question": (add_option.get("question") or "").strip(),
            "answer": (add_option.get("answer") or "").strip(),
        },
        "search_option": raw.get("search_option") or "keep",  # keep / on / off
    }


def build_diff(client, groups: list[dict], raw_template: dict, caps: dict, adapter: dict) -> dict:
    template = normalize_template(raw_template)
    unknown = tpl.unknown_vars(template["group_name"]) + tpl.unknown_vars(template["notice"])
    warnings: list[str] = []
    if unknown:
        warnings.append("模板里有未知变量：" + "、".join("{%s}" % name for name in dict.fromkeys(unknown)))

    if not any([template["group_name"], template["notice"], template["portrait"],
                template["whole_ban"] != "keep", template["add_option"]["mode"] != "keep",
                template["search_option"] != "keep"]):
        raise AppError("模板是空的", hint="至少填写一项要修改的群设置。")

    if template["portrait"] and not caps.get("portrait", True):
        warnings.append("当前协议端不支持修改群头像，该项会被跳过。")
    if template["notice"] and not caps.get("notice", True):
        warnings.append("当前协议端不支持群公告，该项会被跳过。")
    if template["add_option"]["mode"] != "keep" and not caps.get("add_option", True):
        warnings.append("当前协议端不支持加群方式设置，该项会被跳过。")

    result_groups = []
    total_changes = 0

    for group in groups:
        group_id = str(group["group_id"])
        current_name = group.get("group_name") or ""
        info = _current_group_info(client, group_id)
        if info.get("group_name"):
            current_name = info["group_name"]
        current_notice = _current_notice(client, group_id, adapter) if template["notice"] else ""

        fields: list[dict] = []

        if template["group_name"]:
            target = tpl.render(
                template["group_name"],
                {"group_name": current_name, "group_id": group_id},
            )
            target, clamped = tpl.clamp(target, tpl.GROUP_NAME_MAX_LEN)
            fields.append(
                {
                    "key": "group_name",
                    "label": FIELD_LABELS["group_name"],
                    "supported": True,
                    "from": current_name,
                    "to": target,
                    "changed": target != current_name,
                    "note": "超长已截断" if clamped else "",
                }
            )

        if template["notice"]:
            fields.append(
                {
                    "key": "notice",
                    "label": FIELD_LABELS["notice"],
                    "supported": bool(caps.get("notice", True)),
                    "from": current_notice[:60] + ("…" if len(current_notice) > 60 else ""),
                    "to": template["notice"][:80] + ("…" if len(template["notice"]) > 80 else ""),
                    "changed": current_notice != template["notice"],
                    "note": "",
                }
            )

        if template["whole_ban"] != "keep":
            fields.append(
                {
                    "key": "whole_ban",
                    "label": FIELD_LABELS["whole_ban"],
                    "supported": True,
                    "from": "（当前状态未知）",
                    "to": "开启" if template["whole_ban"] == "on" else "关闭",
                    "changed": True,
                    "note": "全员禁言会阻止普通成员发言",
                }
            )

        if template["portrait"]:
            fields.append(
                {
                    "key": "portrait",
                    "label": FIELD_LABELS["portrait"],
                    "supported": bool(caps.get("portrait", True)),
                    "from": "（当前头像）",
                    "to": template["portrait"],
                    "changed": True,
                    "note": "支持本地绝对路径或图片直链",
                }
            )

        if template["add_option"]["mode"] != "keep":
            mode = template["add_option"]["mode"]
            fields.append(
                {
                    "key": "add_option",
                    "label": FIELD_LABELS["add_option"],
                    "supported": bool(caps.get("add_option", True)),
                    "from": "（当前设置未知）",
                    "to": "需要回答问题" if mode == "question" else "允许直接加入",
                    "changed": True,
                    "note": "实验性接口，失败不影响其他项" if mode == "question" else "",
                }
            )

        if template["search_option"] != "keep":
            fields.append(
                {
                    "key": "search_option",
                    "label": FIELD_LABELS["search_option"],
                    "supported": bool(caps.get("search_option", False)),
                    "from": "（当前设置未知）",
                    "to": "允许通过群号搜索" if template["search_option"] == "on" else "禁止搜索",
                    "changed": True,
                    "note": "实验性接口，不同版本参数可能不同",
                }
            )

        actionable = [field for field in fields if field["supported"] and field["changed"]]
        total_changes += len(actionable)
        result_groups.append(
            {
                "group_id": group_id,
                "group_name": current_name,
                "fields": fields,
                "actionable": len(actionable),
                "skipped": len([field for field in fields if not field["supported"]]),
            }
        )

    return {
        "template": template,
        "groups": result_groups,
        "total_changes": total_changes,
        "warnings": warnings,
    }


def build_tasks(diff_groups: list[dict], template: dict) -> list[dict]:
    tasks: list[dict] = []
    for group in diff_groups:
        group_id = str(group["group_id"])
        for field in group["fields"]:
            if not field["supported"] or not field["changed"]:
                continue

            key = field["key"]
            label = f'{group["group_name"]} · {field["label"]}'
            if key == "group_name":
                tasks.append(
                    {
                        "target": group_id,
                        "label": label,
                        "action": "set_group_name",
                        "params": {"group_id": group_id, "group_name": field["to"]},
                    }
                )
            elif key == "notice":
                tasks.append(
                    {
                        "target": group_id,
                        "label": label,
                        "action": "_send_group_notice",
                        "params": {"group_id": group_id, "content": template["notice"]},
                    }
                )
            elif key == "whole_ban":
                tasks.append(
                    {
                        "target": group_id,
                        "label": label,
                        "action": "set_group_whole_ban",
                        "params": {"group_id": group_id, "enable": template["whole_ban"] == "on"},
                    }
                )
            elif key == "portrait":
                tasks.append(
                    {
                        "target": group_id,
                        "label": label,
                        "action": "set_group_portrait",
                        "params": {"group_id": group_id, "file": template["portrait"]},
                    }
                )
            elif key == "add_option":
                mode = template["add_option"]["mode"]
                params = {"group_id": group_id, "add_type": 1 if mode == "question" else 0}
                if mode == "question":
                    params["question"] = template["add_option"]["question"]
                    params["answer"] = template["add_option"]["answer"]
                tasks.append({"target": group_id, "label": label, "action": "set_group_add_option", "params": params})
            elif key == "search_option":
                tasks.append(
                    {
                        "target": group_id,
                        "label": label,
                        "action": "set_group_search_option",
                        "params": {"group_id": group_id, "search": template["search_option"] == "on"},
                    }
                )
    return tasks
