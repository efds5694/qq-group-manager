"""内置和自定义筛选预设使用同一种条件树。"""
from __future__ import annotations

import copy
import datetime
import uuid

from ..core import filters
from ..core.errors import AppError


def condition(field, op="eq", value=None, **extra):
    return {"field": field, "op": op, "value": value, **extra}


def relation(where, quantifier="any", **extra):
    return {"relation": "memberships", "quantifier": quantifier, "where": where, **extra}


def listing(config, entity="memberships"):
    year = datetime.datetime.now().year
    rules = [
        ("all", "全部", {"op": "and", "rules": []}),
        ("managed", "可管理的群", condition("group.manageable", value=True)),
        ("favorite", "收藏的群", condition("group.favorite", value=True)),
        ("teachers", "【师生】群", condition("group.display_name", "regex", r"^【师生】")),
        ("tagged", "名称或备注以【标签】开头", {"op": "or", "rules": [
            condition("group.group_name", "regex", r"^【[^【】\r\n]+】"),
            condition("group.group_remark", "regex", r"^【[^【】\r\n]+】")]}),
        ("owner", "群主", condition("member.role", value="owner")),
        ("admin", "管理员", condition("member.role", value="admin")),
        ("member", "普通成员", condition("member.role", value="member")),
        ("empty-card", "空群昵称", condition("member.card", "empty")),
        ("year", "按加群年份…", condition("member.join_time", "between", [f"{year}-01-01", f"{year}-12-31T23:59:59"])),
        ("inactive", "超过 30 天未发言", condition("member.last_sent_time", "older_days", 30)),
        ("muted", "正在禁言", condition("member.muted", value=True)),
        ("single", "只在一个群", condition("person.group_count", value=1)),
        ("multiple", "在多个群", condition("person.group_count", "gt", 1)),
        ("intersection", "同时在范围内全部群", condition("person.in_all", value=True)),
        ("different", "目标群昵称不一致", condition("person.nickname_difference", value=True)),
        ("conflict", "基准群昵称有差异", condition("person.source_conflict", value=True)),
        ("no-reference", "没有基准群昵称", condition("person.reference_card", "empty")),
        ("in-group", "在指定群…", relation(condition("group.group_id", value="请填写群号"))),
        ("not-in-group", "不在指定群…", relation(condition("group.group_id", value="请填写群号"), "none")),
        ("missing-course", "在师生群但不在课程群", {"op": "and", "rules": [
            relation(condition("group.display_name", "regex", r"^【师生】")),
            relation(condition("group.display_name", "regex", r"^【课程】"), "none")]}),
    ]
    if entity == "groups":
        group_keys = {"all", "managed", "favorite", "teachers", "tagged", "owner", "admin", "member"}
        role_names = {"owner": "我是群主的群", "admin": "我是管理员的群", "member": "我是普通成员的群"}
        rules = [(key, role_names.get(key, name), condition("group.my_role", value=key) if key in role_names else rule)
                 for key, name, rule in rules if key in group_keys]
    return [{"id": "builtin-"+key, "name": name, "rule": rule, "builtin": True,
             "parameterized": key in ("year", "in-group", "not-in-group")} for key, name, rule in rules] + copy.deepcopy(config.get("filter_presets", []))


def catalog(config):
    return {"presets": listing(config), "group_presets": listing(config, "groups")}


def save(config, raw):
    name = str(raw.get("name", "")).strip()
    if not name:
        raise AppError("请为筛选预设命名")
    rule = raw.get("rule")
    filters.validate(rule)
    key = raw.get("id") or uuid.uuid4().hex[:12]
    if key.startswith("builtin-"):
        raise AppError("内置预设请另存为自定义预设")
    result = {"id": key, "name": name, "rule": rule, "builtin": False}
    config["filter_presets"] = [item for item in config.get("filter_presets", []) if item["id"] != key] + [result]
    return result


def delete(config, key):
    if key.startswith("builtin-"):
        raise AppError("内置预设不能删除")
    config["filter_presets"] = [item for item in config.get("filter_presets", []) if item["id"] != key]
