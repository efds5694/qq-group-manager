"""批量改群昵称：预演计划 + 任务构建 + 回滚。

预演是纯本地计算，一个写请求都不发。
只有用户确认后，api 层才会把计划转成任务提交给 JobManager。
"""

from __future__ import annotations

from ..core import template as tpl
from ..core.errors import AppError

SCOPE_LABELS = {
    "all": "全部成员",
    "selected": "已勾选成员",
    "empty_card": "仅空群昵称",
    "role": "按身份",
    "year": "按入群年份",
    "mapping": "按导入名单",
}


def _select(members: list[dict], options: dict) -> tuple[list[dict], set[str]]:
    """返回 (命中的成员, 命中的 QQ 集合)。"""
    scope = options.get("scope") or "all"
    selected = {str(item) for item in (options.get("selected") or [])}

    if scope == "selected":
        return [m for m in members if m["qq"] in selected], selected
    if scope == "empty_card":
        return [m for m in members if not m["card"]], {m["qq"] for m in members if not m["card"]}
    if scope == "role":
        role = options.get("role") or "member"
        picked = [m for m in members if m["role"] == role]
        return picked, {m["qq"] for m in picked}
    if scope == "year":
        year = str(options.get("year") or "")
        picked = [m for m in members if m["join_year"] == year]
        return picked, {m["qq"] for m in picked}
    if scope == "mapping":
        mapping = options.get("mapping") or {}
        picked = [m for m in members if str(m["qq"]) in mapping]
        return picked, {m["qq"] for m in picked}
    return list(members), {m["qq"] for m in members}


def _can_edit(member: dict, self_id: str, self_role: str) -> str:
    """返回空字符串表示可以改，否则返回跳过原因。"""
    role = member["role"]
    if role == "owner":
        return "群主群昵称不可修改"
    if member["qq"] == str(self_id) and self_role == "owner":
        return "群主无法修改自己的群昵称"
    if self_role == "admin" and role == "admin":
        return "管理员无法修改同级管理员"
    if self_role not in ("owner", "admin"):
        return "自己在群内没有管理权限"
    return ""


def explain_role(role: str) -> str:
    return {"owner": "群主", "admin": "管理员", "member": "成员"}.get(role, "成员")


def preview(
    members: list[dict],
    group: dict,
    options: dict,
    self_id: str,
    self_role: str,
    interval: float = 2.0,
) -> dict:
    template = (options.get("template") or "").strip()
    scope = options.get("scope") or "all"

    if scope != "mapping" and not template:
        raise AppError("没有填写群昵称模板", hint="例如 {nickname}-2026")

    unknown = tpl.unknown_vars(template)
    warnings: list[str] = []
    if unknown:
        warnings.append("模板里有未知变量（会原样保留）：" + "、".join("{%s}" % name for name in unknown))

    candidates, hit_qq = _select(members, options)
    mapping = options.get("mapping") or {}

    items: list[dict] = []
    skipped: list[dict] = []
    reasons: dict[str, int] = {}
    clamped_count = 0

    for index, member in enumerate(candidates, start=1):
        reason = _can_edit(member, self_id, self_role)
        if reason:
            skipped.append({"qq": member["qq"], "display_name": member["display_name"], "reason": reason})
            reasons[reason] = reasons.get(reason, 0) + 1
            continue

        if scope == "mapping":
            new_card = str(mapping.get(member["qq"], "") or "").strip()
            if not new_card:
                skipped.append({"qq": member["qq"], "display_name": member["display_name"], "reason": "导入名单里没有对应群昵称"})
                reasons["导入名单里没有对应群昵称"] = reasons.get("导入名单里没有对应群昵称", 0) + 1
                continue
        else:
            context = tpl.build_context(member, group, index)
            new_card = tpl.render(template, context)

        new_card, clamped = tpl.clamp(new_card, tpl.CARD_MAX_LEN)
        if clamped:
            clamped_count += 1
        if not new_card:
            skipped.append({"qq": member["qq"], "display_name": member["display_name"], "reason": "模板渲染结果为空"})
            reasons["模板渲染结果为空"] = reasons.get("模板渲染结果为空", 0) + 1
            continue
        if new_card == member["card"]:
            skipped.append({"qq": member["qq"], "display_name": member["display_name"], "reason": "群昵称一致，无需修改"})
            reasons["群昵称一致，无需修改"] = reasons.get("群昵称一致，无需修改", 0) + 1
            continue

        items.append(
            {
                "qq": member["qq"],
                "nickname": member["nickname"],
                "role": member["role"],
                "role_label": member["role_label"],
                "old_card": member["card"],
                "new_card": new_card,
                "clamped": clamped,
            }
        )

    if clamped_count:
        warnings.append(f"有 {clamped_count} 人的结果超过 {tpl.CARD_MAX_LEN} 字符，已自动截断。")
    if self_role == "admin":
        warnings.append("你是管理员：只能修改普通成员的群昵称，群主与其他管理员会被跳过。")

    samples = [
        {
            "label": item["nickname"] or item["qq"],
            "old_card": item["old_card"],
            "new_card": item["new_card"],
        }
        for item in items[:3]
    ]

    return {
        "items": items,
        "skipped": skipped,
        "stats": {
            "candidates": len(candidates),
            "hit": len(hit_qq),
            "change": len(items),
            "skip": len(skipped),
            "reasons": reasons,
            "clamped": clamped_count,
        },
        "warnings": warnings,
        "samples": samples,
        "scope_label": SCOPE_LABELS.get(scope, scope),
        "eta_seconds": int(len(items) * float(interval)),
        "group": {"group_id": group.get("group_id"), "group_name": group.get("group_name")},
    }


def build_tasks(plan_items: list[dict], group_id: str) -> list[dict]:
    return [
        {
            "target": item["qq"],
            "label": f'{item.get("nickname") or item["qq"]} → {item["new_card"]}',
            "action": "set_group_card",
            "params": {"group_id": str(group_id), "user_id": str(item["qq"]), "card": item["new_card"]},
        }
        for item in plan_items
    ]


def preview_sync(
    rows: list[dict],
    entries: dict[str, dict],
    group_map: dict[str, dict],
    target_ids: list[str],
    self_id: str,
    *,
    only_empty: bool = False,
    interval: float = 2.0,
    reviewed: list[dict] | None = None,
) -> dict:
    """将参考群昵称转换成逐群 mapping，沿用单群权限、截断与差异判断。

    reviewed 用于执行阶段：只重查已预演的目标，保留用户看过的新群昵称。
    """
    items, skipped, warnings = [], [], []
    for gid in target_ids:
        group = group_map[gid]
        member_list = entries[gid]["members"]
        member_map = {member["qq"]: member for member in member_list}
        myself = member_map.get(str(self_id)) or {}
        self_role = myself.get("role") or group.get("my_role") or "member"
        candidates = ([item for item in reviewed if item["group_id"] == gid]
                      if reviewed is not None else rows)
        mapping, sources = {}, {}
        for row in candidates:
            qq = row["qq"]
            member = member_map.get(qq)
            new_card = row.get("new_card") if reviewed is not None else row["reference_card"]
            reason = ""
            if not member:
                reason = "未加入目标群"
            elif not new_card:
                reason = "没有非空参考群昵称"
            elif only_empty and member["card"]:
                reason = "目标群已有群昵称（只补空群昵称）"
            if reason:
                skipped.append({"group_id": gid, "group_name": group["group_name"],
                                "qq": qq, "display_name": row.get("nickname") or qq, "reason": reason})
                continue
            mapping[qq] = new_card
            sources[qq] = row.get("source_group_id", "")

        plan = preview(member_list, group, {"scope": "mapping", "mapping": mapping},
                       self_id, self_role, interval)
        for item in plan["items"]:
            item.update(group_id=gid, group_name=group["group_name"], source_group_id=sources[item["qq"]])
        for item in plan["skipped"]:
            item.update(group_id=gid, group_name=group["group_name"])
        items.extend(plan["items"])
        skipped.extend(plan["skipped"])
        warnings.extend(f'{group["group_name"]}：{warning}' for warning in plan["warnings"])

    reasons: dict[str, int] = {}
    for item in skipped:
        reasons[item["reason"]] = reasons.get(item["reason"], 0) + 1
    return {
        "items": items,
        "skipped": skipped,
        "warnings": warnings,
        "stats": {"change": len(items), "people": len({item["qq"] for item in items}),
                  "skip": len(skipped), "reasons": reasons},
        "interval": interval,
        "eta_seconds": int(len(items) * interval),
    }


def build_rollback_tasks(snapshot: dict, group_id: str) -> list[dict]:
    entries = snapshot.get("members") or []
    tasks = []
    for entry in entries:
        qq = str(entry.get("qq") or "")
        card = str(entry.get("card") or "")
        if not qq:
            continue
        tasks.append(
            {
                "target": qq,
                "label": f"{qq} 恢复为「{card or '空群昵称'}」",
                "action": "set_group_card",
                "params": {"group_id": str(group_id), "user_id": qq, "card": card},
            }
        )
    return tasks


def snapshot_payload(members: list[dict], group: dict, note: str = "") -> dict:
    return {
        "group_name": group.get("group_name", ""),
        "note": note,
        "members": [{"qq": m["qq"], "card": m["card"], "nickname": m["nickname"]} for m in members],
    }
