"""查询结果上的群昵称操作：来源、正则和模板共用预演与权限判断。"""
from __future__ import annotations

from ..core import fields, filters, template
from ..core.errors import AppError
from . import cards, query


def transformed(text, options):
    mode = options.get("mode", "off")
    if mode == "off":
        return text, ""
    pattern = filters.regex(options.get("pattern", ""), options.get("flags", ""))
    match = pattern.search(text)
    if not match:
        return "", "正则未匹配"
    try:
        if mode == "extract":
            key = str(options.get("capture", "1" if pattern.groups else "0"))
            result = match.group(int(key) if key.isdigit() else key) or ""
        elif mode == "replace":
            result = pattern.sub(str(options.get("replacement", "")), text)
        else:
            raise AppError("正则处理方式无效")
    except (IndexError, KeyError, ValueError) as exc:
        raise AppError("捕获组不存在", hint=str(exc)) from exc
    except Exception as exc:
        raise AppError("正则替换内容无效", hint=str(exc)) from exc
    return result, "" if result.strip() else "正则结果为空"


def preview(dataset, spec, self_id, interval=2):
    query_spec = spec.get("query") or {}
    result = query.execute(dataset, query_spec, paginate=False)
    matched_ids = {key for item in result["items"] for key in (item.get("matched_ids") or [item["id"]])}
    options = spec.get("options") or {}
    transform = options.get("regex") or {}
    if transform.get("mode", "off") != "off":
        filters.regex(transform.get("pattern", ""), transform.get("flags", ""))
    method = options.get("method", "sync")
    if method not in ("sync", "template", "mapping"):
        raise AppError("群昵称生成方式无效")
    source_order = (query_spec.get("scope") or {}).get("source_group_ids", [])
    sources = set(source_order)
    if method == "sync" and not sources:
        raise AppError("请选择基准群")
    contexts = {record["id"]: record for record in dataset["source_records"]}
    target_ids = list(dataset["groups"])
    if method == "sync":
        target_ids = [gid for gid in target_ids if gid not in sources]
    if not target_ids:
        raise AppError("没有目标群", hint="基准群只作来源，请选择其他群作为查看和修改范围。")
    items, skipped, warnings = [], [], []
    for gid in target_ids:
        group = dataset["groups"][gid]
        legacy = dataset["entries"][gid]["members"]
        myself = next((member for member in legacy if member["qq"] == str(self_id)), {})
        role = myself.get("role") or group.get("my_role") or "member"
        mapping, source_lookup = {}, {}
        for record in dataset["records"]:
            if record["group"]["group_id"] != gid or record["id"] not in matched_ids:
                continue
            qq = record["member"]["qq"]
            source_key = options.get("source_field", "member.card")
            source_id = ""
            if method == "sync":
                source_id = next((source_gid for source_gid in source_order if f"{source_gid}:{qq}" in contexts
                                  and fields.value(contexts[f"{source_gid}:{qq}"], source_key) is not fields.MISSING
                                  and fields.display(fields.value(contexts[f"{source_gid}:{qq}"], source_key), fields.BY_ID.get(source_key)).strip()), "")
            source_record = contexts.get(f"{source_id}:{qq}") if source_id else record
            reason = ""
            if method == "mapping":
                text = str((options.get("mapping") or {}).get(qq, ""))
                if not text:
                    reason = "名单中没有对应的新群昵称"
            elif method == "sync" and not source_id:
                text, reason = "", "没有非空基准群昵称"
            else:
                val = fields.value(source_record, source_key)
                text = "" if val is fields.MISSING else fields.display(val, fields.BY_ID.get(source_key))
                if val is fields.MISSING:
                    reason = "源字段未提供，请先补全资料"
            if not reason:
                text, reason = transformed(text, transform)
            if not reason:
                context = template.build_context(next(member for member in legacy if member["qq"] == qq), group, len(mapping)+1)
                context.update(result=text)
                text = template.render(options.get("template", "{result}"), context)
                if not text:
                    reason = "生成的群昵称为空"
            if reason:
                skipped.append({"group_id": gid, "group_name": group["display_name"], "qq": qq, "reason": reason})
            else:
                mapping[qq] = text
                source_lookup[qq] = source_id
        plan = cards.preview(legacy, {**group, "group_name": group["display_name"]},
                             {"scope": "mapping", "mapping": mapping}, self_id, role, interval)
        for item in plan["items"]:
            item.update(group_id=gid, group_name=group["display_name"], source_group_id=source_lookup[item["qq"]])
        for item in plan["skipped"]:
            item.update(group_id=gid, group_name=group["display_name"])
        items.extend(plan["items"])
        skipped.extend(plan["skipped"])
        warnings.extend(plan["warnings"])
    return {"items": items, "skipped": skipped, "warnings": list(dict.fromkeys(warnings)),
            "stats": {"change": len(items), "skip": len(skipped), "people": len({item["qq"] for item in items})},
            "interval": interval, "eta_seconds": int(len(items)*interval)}
