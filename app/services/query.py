"""统一查询：群聊、群成员记录和跨群视图共用数据、条件与投影。"""
from __future__ import annotations

import time

from ..core import fields, filters
from ..core.errors import AppError
from ..core.template import clamp, CARD_MAX_LEN
from . import collection, groups, members


def _number(value):
    try:
        return float(value) if "." in str(value) else int(value)
    except (TypeError, ValueError):
        return None


def _sources(detail, section):
    return {action: result["data"] for action, result in detail.get(section, {}).items()
            if result.get("status") == "ok" and "data" in result}


def normalize_group(group, detail, favorite=False, show_remark=True):
    raw = {**group.get("raw", {})}
    raw.update(_sources(detail, "group"))
    result = {key: group[key] for key in ("group_id", "group_name", "group_remark", "member_count", "max_member_count", "my_role", "manageable") if key in group}
    for action in ("get_group_list", "get_group_info", "get_group_detail_info", "get_group_info_ex"):
        info = raw.get(action, {})
        if not isinstance(info, dict):
            continue
        for key in ("group_name", "group_remark", "member_count", "max_member_count"):
            newer = action == "get_group_list" or detail.get("group", {}).get(action, {}).get("at", 0) >= group.get("fetched_at", 0)
            if key in info and (key not in result or newer) and (info[key] != "" or key != "group_remark"):
                result[key] = info[key]
        for key in ("group_all_shut", "group_all_shut_up", "shutUpAllTimestamp"):
            if key in info:
                result["whole_ban"] = bool(info[key])
        for key in ("ownerUin", "owner_id"):
            if info.get(key):
                result["owner_id"] = str(info[key])
        for key in ("group_create_time", "create_time", "groupCreateTime"):
            if info.get(key):
                result["created_at"] = info[key]
    remaining = raw.get("get_group_at_all_remain", {})
    if isinstance(remaining, dict) and "remain_at_all_count_for_uin" in remaining:
        result["at_all_remaining"] = remaining["remain_at_all_count_for_uin"]
    if not result.get("my_role"):
        result.pop("my_role", None)
        result.pop("manageable", None)
    result.update(raw=raw, favorite=favorite)
    result["fetched_at"] = group.get("fetched_at")
    result["display_name"] = (result.get("group_remark") if show_remark else "") or result.get("group_name") or result["group_id"]
    return result


def normalize_member(member, detail, list_at=0):
    raw = dict(member.get("raw", {}))
    sources = detail.get("members", {}).get(member["qq"], {})
    raw.update({action: result["data"] for action, result in sources.items() if result.get("status") == "ok"})
    # 旧缓存保留其已知字段，新接口数据只使用实际提供的键。
    base = dict(raw.get("get_group_member_list", member))
    if not member.get("raw"):
        base["join_time"] = member.get("join_ts", 0)
        base["last_sent_time"] = member.get("last_sent_ts", 0)
    info = raw.get("get_group_member_info", {})
    if isinstance(info, dict):
        info_at = sources.get("get_group_member_info", {}).get("at", 0)
        base = {**base, **info} if info_at >= list_at else {**info, **base}
    result = {key: base[key] for key in ("nickname", "card", "role", "level", "title", "join_time", "last_sent_time",
              "sex", "age", "area", "qq_level", "qage", "is_robot", "shut_up_timestamp", "title_expire_time",
              "card_changeable", "unfriendly") if key in base}
    result.update(qq=str(base.get("user_id") or member["qq"]), raw=raw)
    for key in ("level", "age", "qq_level", "join_time", "last_sent_time", "shut_up_timestamp", "title_expire_time"):
        if key in result:
            number = _number(result[key])
            if number is not None:
                result[key] = number
            else:
                result.pop(key)
    group_sources = _sources(detail, "group")
    shut = group_sources.get("get_group_shut_list")
    if isinstance(shut, list):
        muted = next((item for item in shut if str(item.get("uin") or item.get("user_id")) == result["qq"]), None)
        result["shut_up_timestamp"] = int((muted or {}).get("shutUpTime") or (muted or {}).get("shut_up_timestamp") or 0)
    if "shut_up_timestamp" in result:
        result["muted"] = result["shut_up_timestamp"] > time.time()
    honor = group_sources.get("get_group_honor_info")
    if isinstance(honor, dict):
        result["honors"] = [name for name, items in honor.items() if isinstance(items, list)
                            and any(str(item.get("user_id")) == result["qq"] for item in items if isinstance(item, dict))]
    return result


def prepare(client, self_id, spec):
    entity = spec.get("entity", "memberships")
    if entity not in ("groups", "memberships", "people"):
        raise AppError("查询对象无效")
    rule = spec.get("filter")
    if rule is None:
        rule = {"op": "and", "rules": []}
    filters.validate(rule)
    scope = spec.get("scope") or {}
    listing = groups.list_groups(client, self_id, force=bool(spec.get("refresh")))
    all_map = {group["group_id"]: group for group in listing}
    ids = list(dict.fromkeys(str(gid) for gid in scope.get("group_ids", [])))
    if not ids and entity != "groups":
        raise AppError("请先选择要查看的群")
    if not ids:
        ids = list(all_map)
    missing = [gid for gid in ids if gid not in all_map]
    if missing:
        raise AppError("部分群已不在当前账号的群列表中", hint="、".join(missing))
    source_ids = [str(gid) for gid in scope.get("source_group_ids", []) if str(gid) in all_map]
    load_ids = list(dict.fromkeys(ids + source_ids))
    details = {gid: collection.load(client, gid) for gid in load_ids}
    favorites = set(scope.get("favorite_ids", []))
    group_map = {gid: normalize_group(all_map[gid], details[gid], gid in favorites, scope.get("show_remark", True)) for gid in load_ids}
    if scope.get("group_rule"):
        selector = filters.Predicate(scope["group_rule"])
        ids = [gid for gid in ids if selector({"group": group_map[gid]})]
        load_ids = list(dict.fromkeys(ids + source_ids))
    needs_members = entity != "groups" or filters.has_relation(rule) or any(
        leaf["field"].startswith(("member.", "person.")) for leaf in filters.leaves(rule))
    entries, errors = members.fetch_many(client, load_ids, force=bool(spec.get("refresh"))) if needs_members else ({}, {})
    if errors:
        raise AppError("部分群成员读取失败，未返回不完整结果", hint="、".join(f'{group_map[gid]["display_name"]}（{gid}）' for gid in errors))
    records, by_qq, by_group = [], {}, {gid: [] for gid in load_ids}
    for gid in load_ids:
        for member in entries.get(gid, {}).get("members", []):
            record = {"id": f'{gid}:{member["qq"]}', "group": group_map[gid], "member": normalize_member(member, details[gid], entries[gid]["fetched_at"])}
            records.append(record)
            by_qq.setdefault(member["qq"], []).append({"group": record["group"], "member": record["member"]})
            by_group[gid].append(record)
    sources = source_ids
    targets = [gid for gid in ids if gid not in sources]
    id_set = set(ids)
    visible_by_qq = {qq: [item for item in memberships if item["group"]["group_id"] in id_set]
                     for qq, memberships in by_qq.items()}
    source_field = spec.get("source_field", "member.card")
    people = {}
    for qq, memberships in by_qq.items():
        by_gid = {item["group"]["group_id"]: item for item in memberships}
        references = [(gid, by_gid[gid]["member"].get("card")) for gid in sources if gid in by_gid and by_gid[gid]["member"].get("card")]
        source, card = references[0] if references else ("", "")
        visible = visible_by_qq[qq]
        resolved = []
        for gid in sources:
            if gid not in by_gid:
                continue
            val = fields.value(by_gid[gid], source_field)
            if val is not fields.MISSING and fields.display(val, fields.BY_ID.get(source_field)).strip():
                resolved.append({"group_id": gid, "name": group_map[gid]["display_name"],
                                 "text": fields.display(val, fields.BY_ID.get(source_field))})
        people[qq] = {"group_count": len(visible), "reference_card": card, "source_group_id": resolved[0]["group_id"] if resolved else "",
                      "group_names": [item["group"]["display_name"] for item in visible],
                      "reference_text": resolved[0]["text"] if resolved else "",
                      "source_group_name": resolved[0]["name"] if resolved else "",
                      "source_values": resolved,
                      "source_conflict": len({item["text"] for item in resolved}) > 1,
                      "nickname_difference": bool(resolved) and any(gid in by_gid and by_gid[gid]["member"].get("card") != clamp(resolved[0]["text"], CARD_MAX_LEN)[0] for gid in targets),
                      "in_all": len(visible) == len(ids)}
    all_records = list(records)
    records = [record for record in records if record["group"]["group_id"] in ids]
    for record in records:
        qq, gid = record["member"]["qq"], record["group"]["group_id"]
        record.update(person=people[qq], memberships=visible_by_qq[qq], members=by_group[gid])
    group_rows = [{"id": gid, "group": group_map[gid], "members": by_group[gid]} for gid in ids]
    definitions = fields.discover(group_rows + records)
    return {"entity": entity, "groups": {gid: group_map[gid] for gid in ids}, "all_groups": group_map,
            "records": records, "source_records": all_records, "group_rows": group_rows,
            "entries": entries, "details": details, "fields": definitions, "ids": ids}


def pending_collection(client, dataset, spec):
    """只在条件所需字段尚未请求时补全；失败与未提供不会伪装为筛选结果。"""
    missing_fields, group_needed, member_needed = [], False, False
    for leaf in filters.leaves(spec.get("filter") or {"rules": []}):
        key = leaf["field"]
        rows = dataset["records"] if key.startswith("member.") else dataset["group_rows"] if key.startswith("group.") else []
        absent = [row for row in rows if fields.value(row, key) is fields.MISSING]
        if not absent:
            continue
        missing_fields.append((key, leaf.get("op"), absent))
        if key.startswith("group.") or key in ("member.honors", "member.muted", "member.shut_up_timestamp"):
            group_needed = True
        if key.startswith("member.") and key not in ("member.honors", "member.muted"):
            member_needed = True
    if not missing_fields:
        return None
    work = collection.tasks(client, dataset["entries"], dataset["ids"], required_only=True,
                            include_group=group_needed, include_members=member_needed)
    if work:
        from . import jobs
        return jobs.MANAGER.submit(client, "collect", work, title=f"补全筛选所需资料 · {len(work)} 项", interval=0, retries=0,
                                   meta={"group_ids": dataset["ids"]})
    for key, op, absent in missing_fields:
        for row in absent:
            gid = row["group"]["group_id"]
            detail = dataset["details"][gid]
            states = (detail.get("members", {}).get(row.get("member", {}).get("qq"), {}) if key.startswith("member.") else detail.get("group", {}))
            if key in ("member.honors", "member.muted", "member.shut_up_timestamp"):
                states = detail.get("group", {})
            if any(item.get("status") == "failed" for item in states.values()):
                raise AppError("筛选所需资料采集失败", hint=f"{key} · 群 {gid}。请重试失败项，或调整群范围。")
        if op not in ("missing", "exists"):
            raise AppError("接口未提供筛选所需字段", hint=f"{key}。可改用“未提供”条件查看缺失记录，或调整群范围。")
    return None


def execute(dataset, spec, *, paginate=True):
    definitions = {item["id"]: item for item in dataset["fields"]}
    predicate = filters.Predicate(spec.get("filter"), definitions)
    base = dataset["group_rows"] if dataset["entity"] == "groups" else dataset["records"]
    if dataset["entity"] == "groups":
        # 成员字段预设在群目录中表示“包含匹配成员的群”。
        rule = spec.get("filter") or {"rules": []}
        def member_context(node):
            if node.get("relation") == "members":
                return False
            return node.get("relation") == "memberships" or node.get("field", "").startswith(("member.", "person.")) or any(member_context(child) for child in node.get("rules", []))
        if member_context(rule):
            predicate = filters.Predicate({"relation": "members", "where": rule}, definitions)
    matched = [record for record in base if predicate(record)]
    text = str(spec.get("search", "")).strip().casefold()
    if text:
        keys = ["group.display_name", "group.group_name", "group.group_remark", "group.group_id"] if dataset["entity"] == "groups" else ["member.qq", "member.nickname", "member.card", "group.display_name"]
        matched = [record for record in matched if any(text in fields.display(fields.value(record, key), definitions.get(key)).casefold() for key in keys)]
    if dataset["entity"] == "people":
        by_qq = {}
        for record in matched:
            by_qq.setdefault(record["member"]["qq"], {**record, "matched_ids": []})["matched_ids"].append(record["id"])
        rows = list(by_qq.values())
        for row in rows:
            row["id"] = row["member"]["qq"]
    else:
        rows = matched
    selection = spec.get("selected")
    if selection is not None:
        chosen = set(selection)
        rows = [row for row in rows if row["id"] in chosen]
    sort = spec.get("sort") or {"field": "group.display_name" if dataset["entity"] == "groups" else "member.qq", "desc": False}
    key = sort.get("field", "member.qq")
    def ordering(row):
        val = fields.value(row, key)
        if val is fields.MISSING or val is None:
            return (1, 0, "")
        return (0, 0, val) if isinstance(val, (float, int)) else (0, 1, str(val).casefold())
    rows.sort(key=ordering, reverse=bool(sort.get("desc")))
    grouping = spec.get("group_by") or {}
    buckets = {}
    if grouping.get("field"):
        group_key = grouping["field"]
        pattern = filters.regex(grouping["pattern"], grouping.get("flags", "")) if grouping.get("pattern") else None
        for row in rows:
            text = fields.display(fields.value(row, group_key), definitions.get(group_key))
            match = pattern.search(text) if pattern else None
            bucket = (((match.group(1) if pattern.groups else match.group(0)) if match else None) if pattern else text) or "未分组"
            row["bucket"] = bucket
            buckets[bucket] = buckets.get(bucket, 0) + 1
        rows.sort(key=lambda row: (row["bucket"] == "未分组", row["bucket"]))
    total = len(rows)
    size = max(1, min(int(spec.get("size") or 50), 500))
    pages = max(1, (total + size - 1) // size)
    page = max(1, min(int(spec.get("page") or 1), pages))
    page_rows = rows[(page-1)*size:page*size] if paginate else rows
    columns = spec.get("fields") or (fields.GROUP_COLUMNS if dataset["entity"] == "groups" else fields.MEMBER_COLUMNS)
    columns = [key for key in columns if key in definitions]

    def project(record, keys):
        values, display = {}, {}
        for key in keys:
            val = fields.value(record, key)
            if val is not fields.MISSING:
                values[key] = val
            if val is fields.MISSING:
                detail = dataset["details"].get(record["group"]["group_id"], {})
                states = detail.get("members", {}).get(record.get("member", {}).get("qq"), {}) if key.startswith("member.") else detail.get("group", {})
                if key in ("member.honors", "member.muted", "member.shut_up_timestamp"):
                    states = detail.get("group", {})
                statuses = [item.get("status") for item in states.values()]
                display[key] = "未采集" if not statuses else "采集失败" if "failed" in statuses else "不支持" if all(status == "unsupported" for status in statuses) else "未提供"
            else:
                display[key] = fields.display(val, definitions.get(key))
        return {"values": values, "display": display}

    items = []
    for record in page_rows:
        item = {"id": record["id"], "group_id": record["group"]["group_id"], "qq": record.get("member", {}).get("qq"),
                **project(record, columns)}
        if "bucket" in record:
            item["bucket"] = record["bucket"]
        if (spec.get("scope") or {}).get("source_group_ids"):
            item["source_values"] = record.get("person", {}).get("source_values", [])
        if dataset["entity"] == "people":
            item["matched_ids"] = record["matched_ids"]
            item["person"] = record["person"]
            matrix_keys = list(dict.fromkeys([spec.get("matrix_field", "member.card"), "member.role", "member.card", "member.nickname"]))
            item["memberships"] = [{"group_id": child["group"]["group_id"], **project(child, matrix_keys),
                                     "matched": f'{child["group"]["group_id"]}:{record["member"]["qq"]}' in record["matched_ids"]}
                                    for child in record["memberships"]]
        if spec.get("details"):
            item["raw"] = {"group": record["group"].get("raw", {}), "member": record.get("member", {}).get("raw", {}),
                           "collection": dataset["details"].get(item["group_id"], {})}
        items.append(item)
    data_times = [entry["fetched_at"] for entry in dataset["entries"].values() if entry.get("fetched_at")]
    if not data_times:
        data_times = [group["fetched_at"] for group in dataset["groups"].values() if group.get("fetched_at")]
    return {"items": items, "total": total, "page": page, "size": size, "pages": pages, "fields": dataset["fields"], "buckets": buckets,
            "data_at": min(data_times) if data_times else None,
            "stale": any(entry.get("stale") for entry in dataset["entries"].values()),
            "columns": columns, "people": len({row.get("member", {}).get("qq") for row in matched}) if dataset["entity"] != "groups" else 0,
            "memberships": len(matched) if dataset["entity"] != "groups" else 0,
            "groups": [{"group_id": gid, "name": group["display_name"],
                        "stale": bool(dataset["entries"].get(gid, {}).get("stale")),
                        "fetched_at": dataset["entries"].get(gid, {}).get("fetched_at"),
                        "collection": {action: {key: result[key] for key in ("status", "at", "error") if key in result}
                                       for action, result in dataset["details"][gid].get("group", {}).items()}}
                       for gid, group in dataset["groups"].items()]}
