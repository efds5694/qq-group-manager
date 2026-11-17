"""临时名单核对：来源记录先筛选，再按 QQ 合并，逐个目标群核对。"""
from __future__ import annotations

from ..core import fields, filters
from ..core.errors import AppError

STATUS = {"missing": "缺少", "outside": "名单外", "common": "共有"}
COLUMNS = ["member.qq", "member.nickname", "comparison.status", "comparison.source_card",
           "member.card", "comparison.source_groups", "group.display_name"]


def build(dataset, spec):
    source_ids = [str(gid) for gid in spec.get("source_group_ids", [])]
    target_ids = list(dict.fromkeys(str(gid) for gid in spec.get("target_group_ids", [])))
    if not source_ids or not target_ids:
        raise AppError("请选择名单来源群和待核对群")
    predicate = filters.Predicate(spec.get("source_filter"), {item["id"]: item for item in dataset["fields"]})
    roster, source_groups, source_group_ids = {}, {}, {}
    for row in dataset["records"]:
        if predicate(row):
            qq = row["member"]["qq"]
            roster.setdefault(qq, row)
            source_groups.setdefault(qq, []).append(row["group"]["display_name"])
            source_group_ids.setdefault(qq, []).append(row["group"]["group_id"])
    target_members = {gid: {} for gid in target_ids}
    for row in dataset["source_records"]:
        gid = row["group"]["group_id"]
        if gid in target_members:
            target_members[gid][row["member"]["qq"]] = row
    expected = set(roster)
    summaries = []
    for gid in target_ids:
        actual = set(target_members[gid])
        summaries.append({"group_id": gid, "name": dataset["all_groups"][gid]["display_name"],
                          "expected": len(expected), "actual": len(actual), "missing": len(expected-actual),
                          "outside": len(actual-expected), "common": len(expected & actual)})
    active = str(spec.get("target_group_id") or target_ids[0])
    if active not in target_members:
        raise AppError("待核对群不在本次范围中")
    status = spec.get("status", "missing")
    if status not in (*STATUS, "all"):
        raise AppError("核对状态无效")
    text = str(spec.get("search") or "").strip().casefold()
    definitions = {item["id"]: item for item in dataset["fields"]}
    items = []
    for qq in sorted(expected | set(target_members[active])):
        source, target = roster.get(qq), target_members[active].get(qq)
        state = "common" if source and target else "missing" if source else "outside"
        if status != "all" and state != status:
            continue
        member = (target or source)["member"]
        values = {"member.qq": qq, "member.nickname": member.get("nickname", ""),
                  "comparison.status": state, "comparison.source_card": (source or {}).get("member", {}).get("card", ""),
                  "member.card": target["member"].get("card", "") if target else "未加入",
                  "comparison.source_groups": source_groups.get(qq, []),
                  "group.display_name": dataset["all_groups"][active]["display_name"]}
        display = {key: fields.display(value, definitions.get(key)) for key, value in values.items()}
        display["comparison.status"] = STATUS[state]
        if text and not any(text in val.casefold() for val in display.values()):
            continue
        items.append({"id": f"{active}:{qq}", "qq": qq, "group_id": active,
                      "source_group_ids": source_group_ids.get(qq, []),
                      "detail_group_id": (target or source)["group"]["group_id"], "values": values, "display": display})
    return {"entity": "comparison", "items": items, "total": len(items), "columns": COLUMNS,
            "data_at": min(entry["fetched_at"] for entry in dataset["entries"].values()),
            "stale": any(entry.get("stale") for entry in dataset["entries"].values()),
            "fields": dataset["fields"], "groups": summaries, "summaries": summaries, "expected": len(expected),
            "target_group_id": active, "status": status, "people": len(items), "memberships": len(items)}
