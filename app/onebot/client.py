"""OneBot v11 HTTP 客户端。

只做四件事：拼 URL、带认证头、解析统一响应、把错误翻译成中文。
不掺业务逻辑，方便日后换协议端时直接复用。
"""

from __future__ import annotations

import hashlib
import json
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

from ..core.errors import AppError, NetworkError, UnsupportedAction, explain

# 动作名里既有 set_group_card 也有 _send_group_notice，不做任何改写。
_SAFE_URL_CHARS = "/_-."


class OneBotClient:
    def __init__(self, base_url: str, token: str = "", timeout: float = 30.0) -> None:
        base_url = (base_url or "").strip().rstrip("/")
        if not base_url:
            raise AppError("没有填写服务地址", hint="例如 http://127.0.0.1:3000")
        if not base_url.startswith(("http://", "https://")):
            base_url = "http://" + base_url
        self.base_url = base_url
        self.token = (token or "").strip()
        self.timeout = timeout
        self.cache_namespace = hashlib.sha256(f"{base_url}\0{self.token}".encode()).hexdigest()
        # 显式禁用系统代理：本机 127.0.0.1 走代理会莫名超时（Windows 常见坑）
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    # ---------------------------------------------------------------- 底层调用
    def raw_call(self, action: str, params: dict | None = None, timeout: float | None = None):
        """返回 (ok, data, message, retcode)。网络层错误直接抛异常。"""
        url = f"{self.base_url}/{urllib.parse.quote(action, safe=_SAFE_URL_CHARS)}"
        body = json.dumps(params or {}, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(url, data=body, method="POST")
        request.add_header("Content-Type", "application/json")
        request.add_header("Accept", "application/json")
        if self.token:
            request.add_header("Authorization", f"Bearer {self.token}")

        started = time.perf_counter()
        try:
            with self._opener.open(request, timeout=timeout or self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            raw = exc.read() or b"{}"
            if exc.code in (404, 405):
                raise UnsupportedAction(
                    f"协议端不支持接口 {action}",
                    hint="当前版本可能没有这个扩展接口，该功能已自动隐藏。",
                ) from exc
        except urllib.error.URLError as exc:
            reason = getattr(exc, "reason", exc)
            if isinstance(reason, (socket.timeout, TimeoutError)):
                raise NetworkError(
                    "请求超时",
                    hint="群成员较多时首次拉取可能较慢，可稍后重试；也可以检查 NapCat 是否卡住。",
                ) from exc
            raise NetworkError(
                f"连不上 {self.base_url}",
                hint="确认 NapCat 正在运行，且已在 WebUI 的「网络配置」里启用 HTTP 服务；端口可能被其他程序占用。",
            ) from exc
        except (socket.timeout, TimeoutError) as exc:
            raise NetworkError("请求超时", hint="NapCat 可能繁忙，稍后重试。") from exc

        elapsed_ms = int((time.perf_counter() - started) * 1000)
        try:
            payload = json.loads(raw.decode("utf-8", errors="replace"))
        except json.JSONDecodeError as exc:
            raise AppError(
                "协议端返回的不是 JSON",
                hint="地址可能填成了 WebUI 端口（6099），这里需要的是 HTTP API 端口（默认 3000）。",
            ) from exc

        if not isinstance(payload, dict):
            raise AppError("协议端返回格式异常", hint="确认该地址是 OneBot HTTP 服务。")

        retcode = payload.get("retcode")
        status = payload.get("status")
        ok = status == "ok" or retcode == 0
        message = payload.get("wording") or payload.get("message") or ""

        if not ok:
            text, hint = explain(int(retcode) if isinstance(retcode, int) else -1, str(message))
            setattr(self, "_last_elapsed", elapsed_ms)
            return False, None, text, retcode, hint

        setattr(self, "_last_elapsed", elapsed_ms)
        return True, payload.get("data"), message, retcode, None

    # ---------------------------------------------------------------- 便捷接口
    def call(self, action: str, timeout: float | None = None, **params):
        ok, data, message, retcode, hint = self.raw_call(action, params, timeout=timeout)
        if not ok:
            raise AppError(message or f"{action} 调用失败", retcode=retcode, hint=hint)
        return data

    def try_call(self, action: str, **params):
        """探测用：不抛异常，返回 (ok, data, error)。"""
        try:
            ok, data, message, retcode, hint = self.raw_call(action, params)
            if ok:
                return True, data, None
            return False, None, AppError(message, retcode=retcode, hint=hint)
        except UnsupportedAction as exc:
            return False, None, exc
        except AppError as exc:
            return False, None, exc

    def ping(self) -> dict:
        """连接测试：拿登录号信息 + 版本。"""
        login = self.call("get_login_info", timeout=8)
        self.cache_namespace = hashlib.sha256(
            f"{self.base_url}\0{self.token}\0{(login or {}).get('user_id', '')}".encode()
        ).hexdigest()
        version = None
        try:
            version = self.call("get_version_info", timeout=5)
        except AppError:
            version = None
        return {
            "user_id": str((login or {}).get("user_id", "")),
            "nickname": (login or {}).get("nickname", ""),
            "version": (version or {}).get("app_version") or (version or {}).get("version"),
            "app_name": (version or {}).get("app_name") or "OneBot",
            "base_url": self.base_url,
            "elapsed_ms": getattr(self, "_last_elapsed", 0),
        }

    def describe_error(self, exc: Exception) -> str:
        if isinstance(exc, AppError):
            return exc.message
        return str(exc)
