"""表格、条件编辑器与导出共用字段目录。原始接口字段按路径保留。"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

TZ = timezone(timedelta(hours=8))
MISSING = object()
ROLE_LABELS = {"owner": "群主", "admin": "管理员", "member": "成员"}


def field(key, label, kind="text", source="列表", values=None):
    return {"id": key, "label": label, "type": kind, "source": source, "values": values or []}


FIELDS = [
    field("group.group_name", "群名称"), field("group.group_id", "群号"),
    field("group.group_remark", "群备注", source="群资料"), field("group.display_name", "群显示名"),
    field("group.member_count", "群人数", "number"), field("group.max_member_count", "群人数上限", "number"),
    field("group.my_role", "我的群身份", "enum", values=list(ROLE_LABELS)),
    field("group.manageable", "可管理群", "boolean"), field("group.favorite", "收藏群", "boolean", "本地"),
    field("group.whole_ban", "全员禁言", "boolean", "群详细资料"),
    field("group.owner_id", "群主 QQ号", source="群详细资料"),
    field("group.created_at", "建群时间", "datetime", "群扩展资料"),
    field("group.at_all_remaining", "账号剩余全体提醒次数", "number", "管理状态"),
    field("member.qq", "QQ号"), field("member.nickname", "昵称"), field("member.card", "群昵称"),
    field("member.role", "身份", "enum", values=list(ROLE_LABELS)),
    field("member.level", "等级", "number"), field("member.join_time", "加群时间", "datetime"),
    field("member.last_sent_time", "最后发言", "datetime"), field("member.title", "头衔"),
    field("member.sex", "性别", "enum", values=["male", "female", "unknown"]),
    field("member.age", "年龄", "number", "成员详情"), field("member.area", "地区", source="成员详情"),
    field("member.qq_level", "QQ等级", "number", "成员详情"), field("member.qage", "Q龄", source="成员详情"),
    field("member.is_robot", "机器人", "boolean"),
    field("member.shut_up_timestamp", "禁言结束时间", "datetime", "管理状态"),
    field("member.muted", "正在禁言", "boolean", "管理状态"),
    field("member.honors", "群荣誉", "array", "管理状态"),
    field("member.title_expire_time", "头衔过期时间", "datetime", "成员详情"),
    field("member.card_changeable", "群昵称可修改", "boolean", "成员详情"),
    field("member.unfriendly", "不良记录标识", "boolean", "成员详情"),
    field("person.group_count", "所在群数", "number", "跨群计算"),
    field("person.group_names", "所在群", "array", "跨群计算"),
    field("person.reference_text", "采用的来源文本", source="昵称来源"),
    field("person.source_group_name", "采用的来源群", source="昵称来源"),
    field("person.reference_card", "来源群昵称", source="昵称来源"),
    field("person.source_group_id", "采用的来源群号", source="昵称来源"),
    field("person.source_conflict", "来源文本有差异", "boolean", "昵称来源"),
    field("person.nickname_difference", "目标群昵称不一致", "boolean", "跨群计算"),
    field("person.in_all", "同时在范围内全部群", "boolean", "跨群计算"),
    field("comparison.status", "核对状态", "enum", "名单核对", values=["missing", "outside", "common"]),
    field("comparison.source_card", "名单来源群昵称", source="名单核对"),
    field("comparison.source_groups", "名单来源群", "array", "名单核对"),
]
BY_ID = {item["id"]: item for item in FIELDS}
GROUP_COLUMNS = ["group.display_name", "group.group_id", "group.group_name", "group.group_remark",
                 "group.member_count", "group.my_role"]
MEMBER_COLUMNS = ["member.qq", "member.nickname", "group.display_name", "member.card", "member.role",
                  "member.level", "member.join_time", "member.last_sent_time", "member.title"]


def value(record: dict, path: str):
    current = record
    for key in path.split("."):
        if not isinstance(current, dict) or key not in current:
            return MISSING
        current = current[key]
    return current


def display(item, definition=None):
    if item is MISSING:
        return "未提供"
    if item is None:
        return ""
    kind = (definition or {}).get("type")
    key = (definition or {}).get("id", "")
    if kind == "datetime":
        if not item:
            return ""
        return datetime.fromtimestamp(float(item), TZ).strftime("%Y-%m-%d %H:%M:%S")
    if key in ("member.role", "group.my_role"):
        return ROLE_LABELS.get(item, "未知")
    if key == "member.sex":
        return {"male": "男", "female": "女", "unknown": "未知"}.get(item, str(item))
    if isinstance(item, bool):
        return "是" if item else "否"
    if isinstance(item, list):
        return "、".join(str(part) for part in item) if all(not isinstance(part, (dict, list)) for part in item) else json.dumps(item, ensure_ascii=False)
    if isinstance(item, dict):
        return json.dumps(item, ensure_ascii=False)
    return str(item)


def discover(records: list[dict]) -> list[dict]:
    result = dict(BY_ID)
    seen = set()

    def walk(path, obj):
        if isinstance(obj, dict):
            if (path, id(obj)) in seen:
                return
            seen.add((path, id(obj)))
            for key, val in obj.items():
                walk(f"{path}.{key}" if path else key, val)
        elif path not in result:
            kind = "boolean" if isinstance(obj, bool) else "number" if isinstance(obj, (int, float)) else "array" if isinstance(obj, list) else "text"
            result[path] = field(path, path, kind, "接口原始字段")

    for record in records:
        for entity in ("group", "member"):
            raw = record.get(entity, {}).get("raw", {})
            walk(f"{entity}.raw", raw)
    return list(result.values())
