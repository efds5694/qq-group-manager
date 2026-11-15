"""共享条件树。只有显式条件与标准正则，不执行用户代码。"""
from __future__ import annotations

import re
import time
from datetime import datetime

from . import fields
from .errors import AppError

OPERATORS = {
    "eq": "等于", "ne": "不等于", "contains": "包含", "regex": "正则匹配", "not_regex": "正则不匹配",
    "empty": "为空", "missing": "未提供", "exists": "已提供", "gt": "大于／晚于", "gte": "大于等于",
    "lt": "小于／早于", "lte": "小于等于", "between": "介于", "in": "属于这些值",
    "within_days": "最近 N 天", "older_days": "超过 N 天", "field_ne": "不同于字段",
}


def regex(pattern, flags=""):
    if not isinstance(pattern, str) or any(flag not in "ims" for flag in flags):
        raise AppError("正则格式错误", hint="标记只支持 i、m、s。")
    try:
        return re.compile(pattern, sum({"i": re.I, "m": re.M, "s": re.S}[flag] for flag in set(flags)))
    except re.error as exc:
        raise AppError("正则表达式无效", hint=str(exc)) from exc


def validate(rule):
    if not isinstance(rule, dict):
        raise AppError("筛选条件格式错误")
    if "rules" in rule:
        if rule.get("op", "and") not in ("and", "or", "not") or not isinstance(rule["rules"], list):
            raise AppError("条件组格式错误")
        for child in rule["rules"]:
            validate(child)
    elif "relation" in rule:
        if rule["relation"] not in ("members", "memberships") or rule.get("quantifier", "any") not in ("any", "all", "none", "count"):
            raise AppError("群成员关系条件无效")
        validate(rule.get("where", {"op": "and", "rules": []}))
        if rule.get("quantifier") == "count":
            if rule.get("compare", "gte") not in ("eq", "ne", "gt", "gte", "lt", "lte"):
                raise AppError("数量比较方式无效")
            number(rule.get("value", 1))
    else:
        if not isinstance(rule.get("field"), str) or not rule["field"]:
            raise AppError("请选择筛选字段")
        if rule.get("op", "eq") not in OPERATORS:
            raise AppError("筛选方式无效")
        if rule.get("op") in ("regex", "not_regex"):
            regex(rule.get("value", ""), rule.get("flags", ""))
        if rule.get("op") in ("within_days", "older_days"):
            number(rule.get("value"))


def leaves(rule):
    if "rules" in rule:
        return [leaf for child in rule["rules"] for leaf in leaves(child)]
    if "relation" in rule:
        return leaves(rule.get("where", {"rules": []}))
    return [rule]


def has_relation(rule):
    return "relation" in rule or any(has_relation(child) for child in rule.get("rules", []))


def number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        raise AppError("数值条件需要填写数字")


def comparable(value, definition):
    if definition.get("type") == "datetime" and isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value)
            return parsed.replace(tzinfo=fields.TZ).timestamp() if parsed.tzinfo is None else parsed.timestamp()
        except ValueError:
            pass
    return number(value)


def compare(left, op, right):
    return {"eq": lambda: left == right, "ne": lambda: left != right, "gt": lambda: left > right,
            "gte": lambda: left >= right, "lt": lambda: left < right, "lte": lambda: left <= right}[op]()


class Predicate:
    def __init__(self, rule=None, definitions=None):
        self.rule = {"op": "and", "rules": []} if rule is None else rule
        validate(self.rule)
        self.fields = definitions or fields.BY_ID
        self.now = time.time()
        self.patterns = {id(leaf): regex(leaf.get("value", ""), leaf.get("flags", ""))
                         for leaf in leaves(self.rule) if leaf.get("op") in ("regex", "not_regex")}

    def __call__(self, record):
        return self.match(self.rule, record, record)

    def match(self, rule, record, root):
        if "rules" in rule:
            results = [self.match(child, record, root) for child in rule["rules"]]
            if not results:
                return True
            return any(results) if rule.get("op") == "or" else not any(results) if rule.get("op") == "not" else all(results)
        if "relation" in rule:
            collection = record.get(rule["relation"], root.get(rule["relation"], []))
            results = [self.match(rule.get("where", {"rules": []}), item, root) for item in collection]
            quantifier = rule.get("quantifier", "any")
            if quantifier == "count":
                return compare(sum(results), rule.get("compare", "gte"), number(rule.get("value", 1)))
            return not any(results) if quantifier == "none" else bool(results) and all(results) if quantifier == "all" else any(results)
        key, op = rule["field"], rule.get("op", "eq")
        val = fields.value(record, key)
        if val is fields.MISSING and key.startswith("person."):
            val = fields.value(root, key)
        if op == "missing":
            return val is fields.MISSING
        if op == "exists":
            return val is not fields.MISSING
        if val is fields.MISSING:
            return False
        definition = self.fields.get(key, {})
        if op == "empty":
            return val is None or val == "" or val == [] or (definition.get("type") == "datetime" and val == 0)
        expected = rule.get("value")
        if op == "field_ne":
            other = fields.value(record, str(expected))
            return other is not fields.MISSING and val != other
        if op in ("regex", "not_regex"):
            matched = bool(self.patterns[id(rule)].search(fields.display(val, definition)))
            return not matched if op == "not_regex" else matched
        if op == "contains":
            return str(expected or "").casefold() in fields.display(val, definition).casefold()
        if op in ("within_days", "older_days"):
            return bool(val) and compare(number(val), "gte" if op == "within_days" else "lt", self.now - number(expected) * 86400)
        if op == "in":
            choices = expected if isinstance(expected, list) else [item.strip() for item in str(expected).split(",")]
            if definition.get("type") == "boolean":
                choices = [item if isinstance(item, bool) else str(item).lower() in ("true", "1", "是") for item in choices]
            elif definition.get("type") in ("number", "datetime"):
                choices = [comparable(item, definition) for item in choices]
            return val in choices
        if op in ("gt", "gte", "lt", "lte", "between"):
            if val is None or val == "":
                return False
            if op == "between":
                bounds = expected if isinstance(expected, list) else str(expected).split(",")
                if len(bounds) != 2:
                    raise AppError("范围条件需要两个值，以逗号分隔")
                return comparable(bounds[0], definition) <= number(val) <= comparable(bounds[1], definition)
            return compare(number(val), op, comparable(expected, definition))
        if definition.get("type") == "boolean":
            expected = expected if isinstance(expected, bool) else str(expected).lower() in ("true", "1", "是")
        elif definition.get("type") == "number":
            expected = number(expected)
        elif definition.get("type") == "datetime":
            expected = comparable(expected, definition)
        return compare(val, op, expected)
