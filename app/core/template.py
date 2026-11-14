"""名片 / 群名模板渲染。

支持变量：{nickname} {card} {qq} {group_name} {index} {level} {join_year} {title}
未知变量原样保留，并在预演阶段提示，避免用户以为变量生效了。
"""

from __future__ import annotations

import re

VAR_RE = re.compile(r"\{(\w+)\}")

# QQ 群名片的长度上限。超过后协议端会报错或截断，这里提前拦住。
CARD_MAX_LEN = 40
GROUP_NAME_MAX_LEN = 30

ALLOWED_VARS = (
    "nickname",
    "card",
    "qq",
    "group_name",
    "index",
    "level",
    "join_year",
    "title",
)


def unknown_vars(template: str) -> list[str]:
    found = {match.group(1) for match in VAR_RE.finditer(template or "")}
    return sorted(found - set(ALLOWED_VARS))


def render(template: str, context: dict) -> str:
    def replace(match: re.Match) -> str:
        key = match.group(1)
        value = context.get(key)
        return match.group(0) if value is None else str(value)

    return VAR_RE.sub(replace, template or "").strip()


def build_context(member: dict, group: dict, index: int) -> dict:
    return {
        "nickname": member.get("nickname") or "",
        "card": member.get("card") or "",
        "qq": member.get("qq") or "",
        "group_name": group.get("group_name") or "",
        "index": index,
        "level": member.get("level") or "",
        "join_year": member.get("join_year") or "",
        "title": member.get("title") or "",
    }


def clamp(text: str, limit: int) -> tuple[str, bool]:
    text = (text or "").strip()
    if len(text) <= limit:
        return text, False
    return text[:limit], True
