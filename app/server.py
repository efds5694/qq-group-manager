"""极简 HTTP 服务：路由匹配 + 静态文件 + 统一 JSON 响应。

只用标准库，路由表是「方法 + 正则」，够用且一眼能看懂。
"""

from __future__ import annotations

import json
import re
import traceback
import urllib.parse
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable

from .core.errors import AppError

WEB_DIR = Path(__file__).resolve().parents[1] / "web"
MAX_BODY = 8 * 1024 * 1024

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


@dataclass
class Response:
    body: bytes = b""
    status: int = 200
    headers: dict = field(default_factory=dict)

    @classmethod
    def json(cls, payload: dict, status: int = 200) -> "Response":
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        return cls(raw, status, {"Content-Type": "application/json; charset=utf-8"})

    @classmethod
    def ok(cls, data=None) -> "Response":
        return cls.json({"ok": True, "data": data})

    @classmethod
    def download(cls, raw: bytes, filename: str, content_type: str) -> "Response":
        quoted = urllib.parse.quote(filename)
        return cls(
            raw,
            200,
            {
                "Content-Type": content_type,
                "Content-Disposition": f"attachment; filename*=UTF-8''{quoted}",
            },
        )


class Router:
    def __init__(self) -> None:
        self._routes: list[tuple[str, re.Pattern, Callable]] = []

    def add(self, method: str, pattern: str, handler: Callable) -> None:
        self._routes.append((method.upper(), re.compile(pattern), handler))

    def match(self, method: str, path: str):
        for route_method, pattern, handler in self._routes:
            if route_method != method.upper():
                continue
            found = pattern.match(path)
            if found:
                return handler, found.groupdict()
        return None, None


class Request:
    def __init__(self, method: str, path: str, query: dict, body: dict, headers: dict) -> None:
        self.method = method
        self.path = path
        self.query = query
        self.body = body
        self.headers = headers

    def q(self, name: str, default: str = "") -> str:
        values = self.query.get(name)
        return values[0] if values else default

    def b(self, name: str, default=None):
        return self.body.get(name, default)


def _safe_static(path: str) -> Path | None:
    """静态文件白名单：只允许 web 目录内的已知扩展名。"""
    relative = path.lstrip("/") or "index.html"
    if ".." in relative or relative.startswith("data/"):
        return None
    candidate = (WEB_DIR / relative).resolve()
    try:
        candidate.relative_to(WEB_DIR.resolve())
    except ValueError:
        return None
    if candidate.suffix.lower() not in STATIC_TYPES:
        return None
    return candidate if candidate.is_file() else None


def make_handler(router: Router):
    class Handler(BaseHTTPRequestHandler):
        server_version = "QQGroupManager/1.0"
        protocol_version = "HTTP/1.1"

        # -------------------------------------------------------- 分发
        def do_GET(self) -> None:  # noqa: N802
            self._dispatch("GET")

        def do_POST(self) -> None:  # noqa: N802
            self._dispatch("POST")

        def do_DELETE(self) -> None:  # noqa: N802
            self._dispatch("DELETE")

        def _dispatch(self, method: str) -> None:
            try:
                body = self._read_body() if method in ("POST", "DELETE") else {}
                self._validate_source(method)
            except AppError as exc:
                self.close_connection = True
                self._write(Response.json(exc.to_dict(), exc.status))
                return
            parsed = urllib.parse.urlsplit(self.path)
            path = urllib.parse.unquote(parsed.path)
            query = urllib.parse.parse_qs(parsed.query)

            if method == "GET" and not path.startswith("/api/"):
                self._serve_static(path)
                return

            handler, params = router.match(method, path)
            if not handler:
                self._write(Response.json({"ok": False, "error": "接口不存在"}, 404))
                return

            request = Request(method, path, query, body, dict(self.headers))
            try:
                result = handler(request, **(params or {}))
                if isinstance(result, Response):
                    self._write(result)
                else:
                    self._write(Response.ok(result))
            except AppError as exc:
                self._write(Response.json(exc.to_dict(), exc.status))
            except Exception as exc:  # 兜底，避免服务被单个请求带崩
                traceback.print_exc()
                self._write(
                    Response.json(
                        {"ok": False, "error": "服务内部错误", "hint": str(exc)[:200], "code": "INTERNAL"},
                        500,
                    )
                )

        def _validate_source(self, method: str) -> None:
            allowed = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
            host = self.headers.get("Host", "").lower()
            if host not in allowed:
                raise AppError("不允许的主机地址", status=403)
            origin = self.headers.get("Origin")
            if origin is not None and origin.lower() != f"http://{host}":
                raise AppError("不允许跨站请求", status=403)
            if self.headers.get("Sec-Fetch-Site") == "cross-site":
                raise AppError("不允许跨站请求", status=403)
            if method == "POST" and self.headers.get_content_type() != "application/json":
                raise AppError("请求必须使用 application/json", status=415)

        def _read_body(self) -> dict:
            if self.headers.get("Transfer-Encoding"):
                raise AppError("不支持分块请求", status=400)
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                raise AppError("无效的请求长度", status=400)
            if length < 0:
                raise AppError("无效的请求长度", status=400)
            if length == 0:
                return {}
            if length > MAX_BODY:
                raise AppError("请求内容过大", hint="单个请求不要超过 1MB。", status=413)
            raw = self.rfile.read(length)
            try:
                data = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise AppError("请求体不是合法 JSON", status=400)
            if not isinstance(data, dict):
                raise AppError("请求体必须是 JSON 对象", status=400)
            return data

        # -------------------------------------------------------- 静态资源
        def _serve_static(self, path: str) -> None:
            file_path = _safe_static(path)
            if not file_path:
                self._write(Response.json({"ok": False, "error": "页面不存在"}, 404))
                return
            raw = file_path.read_bytes()
            content_type = STATIC_TYPES.get(file_path.suffix.lower(), "application/octet-stream")
            self._write(Response(raw, 200, {"Content-Type": content_type, "Cache-Control": "no-store"}))

        # -------------------------------------------------------- 输出
        def _write(self, response: Response) -> None:
            self.send_response(response.status)
            headers = dict(response.headers)
            headers.setdefault("Cache-Control", "no-store")
            for key, value in headers.items():
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(response.body)))
            self.end_headers()
            self.wfile.write(response.body)

        def log_message(self, fmt: str, *args) -> None:
            # 正常请求不刷屏，只保留 5xx
            if args and str(args[1]).startswith("5"):
                print(f"[http] {self.address_string()} {fmt % args}")

    return Handler


def serve(router: Router, host: str, port: int) -> ThreadingHTTPServer:
    if host not in ("127.0.0.1", "localhost"):
        raise ValueError("服务仅支持监听 127.0.0.1 或 localhost")
    httpd = ThreadingHTTPServer((host, port), make_handler(router))
    httpd.daemon_threads = True
    return httpd
