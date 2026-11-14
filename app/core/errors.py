"""统一异常类型与 OneBot 错误码的中文解释。

设计目标：
- 业务层只关心 ``AppError.message`` / ``AppError.hint``，前端直接展示；
- 协议层把 retcode 归一化成人类可读的提示，避免界面出现裸错误码。
"""

from __future__ import annotations

# NapCat / OneBot 常见 retcode 说明。未命中的走 wording 兜底。
RETCODE_HINTS: dict[int, tuple[str, str | None]] = {
    100: ("请求参数不合法", "检查群号、QQ 号是否填写正确。"),
    102: ("账号状态异常", "协议端可能已掉线，去 NapCat WebUI 确认登录状态。"),
    103: ("群不存在或未加入", "刷新群列表后重试。"),
    104: ("成员不存在", "该成员可能已退群，刷新成员列表。"),
    106: ("操作频繁被限制", "把批量间隔调大（建议 3 秒以上），稍后再试。"),
    1200: ("账号被风控或操作过于频繁", "立即停止批量任务，等待一段时间再继续，降低频率。"),
    1400: ("权限不足或参数错误", "机器人需要是群主或管理员，且不能修改群主名片。"),
    1401: ("权限不足", "管理员无法修改其他管理员或群主的名片。"),
    1404: ("目标不存在", "刷新数据后重试。"),
    1500: ("操作过于频繁", "调大批量间隔，或分批执行。"),
}


class AppError(Exception):
    """面向用户的异常。message 直接展示，hint 作为灰色补充说明。"""

    code = "APP_ERROR"
    status = 400

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        hint: str | None = None,
        retcode: int | None = None,
        status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        if status:
            self.status = status
        self.hint = hint
        self.retcode = retcode

    def to_dict(self) -> dict:
        payload = {"ok": False, "error": self.message, "code": self.code}
        if self.hint:
            payload["hint"] = self.hint
        if self.retcode is not None:
            payload["retcode"] = self.retcode
        return payload


class NetworkError(AppError):
    code = "NETWORK"
    status = 502


class UnsupportedAction(AppError):
    """协议端不提供该 action，功能需要降级隐藏。"""

    code = "UNSUPPORTED"
    status = 501


def explain(retcode: int, wording: str = "", message: str = "") -> tuple[str, str | None]:
    """把 retcode 翻译成 (中文描述, 建议)。"""
    known = RETCODE_HINTS.get(int(retcode) if retcode is not None else -1)
    if known:
        return known
    fallback = wording or message or f"协议端返回错误码 {retcode}"
    return (fallback, None)
