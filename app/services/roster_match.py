"""把导入名单和来源群昵称拆成可核对的身份字段。"""
from collections import defaultdict
import re
import unicodedata

from ..core.errors import AppError
from . import rosters

HEADERS = {
    "name": {"姓名", "学生姓名", "真实姓名", "name"},
    "class": {"班级", "所在班级", "班级名称", "class"},
    "student": {"学号", "学生学号", "student_id"},
    "phone": {"手机号", "手机号码", "联系电话", "手机", "电话", "phone", "mobile"},
    "qq": rosters.QQ_HEADERS | {"QQ号码".lower()},
}
LABELS = {"pair": "姓名＋班级", "student": "学号", "phone": "手机号", "qq": "QQ号", "name": "仅姓名"}
SEP = re.compile(r"[\s_\-‐‑‒–—―·,，/\\|]+")
NUMBER = re.compile(r"[0-9]+")
PHONE = re.compile(r"1[3-9][0-9]{9}")


def normalize(value):
    return SEP.sub("", unicodedata.normalize("NFKC", value).casefold())


def mask_phone(value):
    return re.sub(r"(?<![0-9])(1[3-9][0-9])([0-9]{4})([0-9]{4})(?![0-9])", r"\1****\3", value)


def read(payload):
    rows = [(line, [rosters._cell(cell) for cell in row]) for line, row in
            enumerate(rosters._read_rows(payload), 1) if any(rosters._cell(cell) for cell in row)]
    if not rows:
        raise AppError("名单中没有有效成员")
    columns = {}
    for index, header in enumerate(rows[0][1]):
        for key, aliases in HEADERS.items():
            if normalize(header) in {normalize(alias) for alias in aliases}:
                if key in columns:
                    raise AppError(f"名单中的{header}字段重复，请保留一列")
                columns[key] = index
    if not columns or not ({"name", "student", "phone", "qq"} & columns.keys()):
        raise AppError("没有识别到姓名、学号、手机号或 QQ号表头")
    entries = []
    seen = set()
    for line, cells in rows[1:]:
        original = {key: cells[index] if index < len(cells) else "" for key, index in columns.items()}
        values = {key: normalize(value) for key, value in original.items()}
        for key in ("qq", "student", "phone"):
            value = values.get(key, "")
            if value and not (PHONE if key == "phone" else NUMBER).fullmatch(value):
                raise AppError(f"名单第 {line} 行{LABELS[key]}格式无效", hint="请保留完整的数字，避免科学计数法。")
        if values.get("qq"):
            values["qq"] = values["qq"].lstrip("0")
        if not any(values.get(key) for key in ("name", "student", "phone", "qq")):
            continue
        signature = tuple(values.items())
        if signature not in seen:
            seen.add(signature)
            entries.append((line, original, values))
    if not entries:
        raise AppError("名单中没有可用于匹配的人员")
    return entries


def match(entries, groups_by_id, lists):
    names = {values["name"] for _, _, values in entries if values.get("name")}
    classes = {values["class"] for _, _, values in entries if values.get("class")}
    student_ids = {values["student"] for _, _, values in entries if values.get("student")}
    class_pattern = "|".join(map(re.escape, sorted(classes, key=lambda value: (-len(value), value))))
    name_pattern = "|".join(map(re.escape, sorted(names, key=lambda value: (-len(value), value))))
    pair_patterns = ([re.compile(f"(?P<cls>{class_pattern})(?P<name>{name_pattern})"),
                      re.compile(f"(?P<name>{name_pattern})(?P<cls>{class_pattern})")]
                     if classes and names else [])
    index = defaultdict(dict)
    accounts = {}
    by_account = defaultdict(lambda: defaultdict(set))
    for group_id, people in lists.items():
        for qq, person in people.items():
            card = person.get("card", "")
            evidence = {"group_id": group_id, "group": groups_by_id[group_id],
                        "card": mask_phone(unicodedata.normalize("NFKC", card))}
            accounts.setdefault(qq, evidence)
            keys = [("qq", qq)]
            # 去掉独立的手机号或学号，再用完整剩余文本识别班级和姓名。
            # 分隔符在提取数字段之后去掉，避免两个原本分开的数字被拼接。
            text = unicodedata.normalize("NFKC", card).casefold()

            def identifier(part):
                value = part.group()
                phone = bool(PHONE.fullmatch(value))
                student = value in student_ids or len(value) == 10
                if phone:
                    keys.append(("phone", value))
                if student:
                    keys.append(("student", value))
                return " " if phone or student else value

            identity = normalize(NUMBER.sub(identifier, text))
            if identity in names:
                keys.append(("name", identity))
            for pattern in pair_patterns:
                parsed = pattern.fullmatch(identity)
                if parsed:
                    keys.extend([("pair", (parsed["cls"], parsed["name"])), ("name", parsed["name"])])
            for key, value in keys:
                index[(key, value)].setdefault(qq, evidence)
                by_account[qq][key].add(value)

    results = []
    proposed = defaultdict(list)
    for line, original, values in entries:
        strong = [(key, values[key]) for key in ("qq", "student", "phone") if values.get(key)]
        if values.get("name") and values.get("class"):
            strong.append(("pair", (values["class"], values["name"])))
        candidates = {}
        for key, value in strong + ([("name", values["name"])] if values.get("name") else []):
            for qq, evidence in index[(key, value)].items():
                candidate = candidates.setdefault(qq, {"qq": qq, "evidence": {}})
                candidate["evidence"][key] = evidence
        exact = [qq for qq, item in candidates.items() if set(item["evidence"]) - {"name"}]
        chosen = exact[0] if len(exact) == 1 else ""
        if chosen and any(by_account[chosen][key] and value not in by_account[chosen][key] for key, value in strong):
            chosen = ""
        row = {"id": str(line), "name": original.get("name", ""), "class": original.get("class", ""),
               "student": original.get("student", ""), "phone": mask_phone(values.get("phone", "")),
               "input_qq": values.get("qq", ""),
               "status": "matched" if chosen else "conflict" if exact else "review" if candidates else "missing",
               "suggested": chosen,
               "candidates": [{"qq": item["qq"], "evidence": [
                   {"field": LABELS[key], **evidence} for key, evidence in item["evidence"].items()
                   if key != "name" or "pair" not in item["evidence"]]}
                   for item in sorted(candidates.values(), key=lambda candidate: (
                       candidate["qq"] not in exact, candidate["qq"]))]}
        results.append(row)
        if chosen:
            proposed[chosen].append(row)
    for rows in proposed.values():
        if len(rows) > 1:
            for row in rows:
                row.update(status="conflict", suggested="")
    return results, accounts


def confirm(rows, accounts, assignments):
    by_id = {row["id"]: row for row in rows}
    if not isinstance(assignments, dict) or not assignments:
        raise AppError("请至少确认一个匹配账号")
    selected = set()
    for row_id, qq in assignments.items():
        if row_id not in by_id or not isinstance(qq, str) or qq not in accounts:
            raise AppError("有账号不在本次来源群中，请重新核对")
        if qq in selected:
            raise AppError("同一个 QQ号被分给了多人，请先处理冲突")
        selected.add(qq)
    return list(assignments.values())
