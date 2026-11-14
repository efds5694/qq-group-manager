"""连接探测：登录信息 + 扩展接口能力集。

只用**只读接口**探测，绝不为了试探而发写请求——
万一探测参数写错，改的是真实群。
写接口（群公告、群头像、加群选项）按适配表声明，运行时遇到「不支持」再降级。
"""

from __future__ import annotations

from ..core.errors import AppError
from .adapters import action, declared_capabilities, get_adapter


def probe(client, adapter_name: str = "napcat") -> dict:
    adapter = get_adapter(adapter_name)
    login = client.ping()

    caps = declared_capabilities(adapter)
    caps["notice"] = False
    notes: list[str] = []

    # 取一个群用于只读探测；没有群就直接返回
    groups = []
    try:
        groups = client.call("get_group_list", timeout=15) or []
    except AppError as exc:
        notes.append(f"群列表读取失败：{exc.message}")

    if groups:
        group_id = str((groups[0] or {}).get("group_id", ""))
        read_action = action(adapter, "notice_read")
        if group_id and read_action:
            ok, _, error = client.try_call(read_action, group_id=group_id)
            if ok:
                caps["notice"] = True
            elif getattr(error, "code", "") == "UNSUPPORTED":
                caps["notice"] = False
                notes.append("协议端没有群公告接口，公告相关功能已隐藏。")
            else:
                # 接口存在但没权限（非管理员），也算支持
                caps["notice"] = True
        caps["group_count"] = len(groups)
    else:
        caps["group_count"] = 0

    return {
        "login": login,
        "adapter": adapter_name,
        "adapter_label": adapter.get("label"),
        "capabilities": caps,
        "notes": notes,
    }
