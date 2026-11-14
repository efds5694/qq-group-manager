"""协议端差异表。

换协议端时只需要动这一个文件：
- ``actions`` 里映射各家的扩展接口名，值为 None 表示该端没有此能力；
- ``declared`` 是乐观声明，真正的可用性以 probe 结果与运行时错误为准。
"""

from __future__ import annotations

ADAPTERS: dict[str, dict] = {
    "napcat": {
        "label": "NapCat",
        "auth": "bearer",
        "actions": {
            "notice_write": "_send_group_notice",
            "notice_read": "get_group_notice",
            "portrait": "set_group_portrait",
            "add_option": "set_group_add_option",
            "search_option": "set_group_search_option",
            "group_info": "get_group_info",
        },
        "declared": {
            "notice": True,
            "portrait": True,
            "add_option": True,
            "search_option": True,
        },
    },
    "llonebot": {
        "label": "LLOneBot",
        "auth": "bearer",
        "actions": {
            "notice_write": "send_group_notice",
            "notice_read": "get_group_notice",
            "portrait": "set_group_portrait",
            "add_option": "set_group_add_option",
            "search_option": None,
            "group_info": "get_group_info",
        },
        "declared": {
            "notice": True,
            "portrait": True,
            "add_option": True,
            "search_option": False,
        },
    },
    "lagrange": {
        "label": "Lagrange.OneBot",
        "auth": "bearer",
        "actions": {
            "notice_write": "send_group_notice",
            "notice_read": "get_group_notice",
            "portrait": "set_group_portrait",
            "add_option": None,
            "search_option": None,
            "group_info": "get_group_info",
        },
        "declared": {
            "notice": True,
            "portrait": True,
            "add_option": False,
            "search_option": False,
        },
    },
}

DEFAULT_ADAPTER = "napcat"


def get_adapter(name: str | None) -> dict:
    return ADAPTERS.get(name or DEFAULT_ADAPTER) or ADAPTERS[DEFAULT_ADAPTER]


def action(adapter: dict, key: str) -> str | None:
    return (adapter.get("actions") or {}).get(key)


def declared_capabilities(adapter: dict) -> dict:
    caps = {key: bool(value) for key, value in (adapter.get("declared") or {}).items()}
    caps["adapter"] = adapter.get("label") or DEFAULT_ADAPTER
    return caps


def list_adapters() -> list[dict]:
    return [{"value": key, "label": value["label"]} for key, value in ADAPTERS.items()]
