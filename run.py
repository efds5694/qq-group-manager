"""入口：加载配置、启动本地服务、自动打开浏览器。

用法：
    python run.py            # 默认 127.0.0.1:8787
    python run.py --port 9000 --no-browser
"""

from __future__ import annotations

import argparse
import socket
import sys
import threading
import webbrowser

from app import api, config, server
from app.core import store


def _configure_console() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def _port_available(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError:
            return False
    return True


def main() -> int:
    _configure_console()
    store.ensure_dirs()
    cfg = config.load()

    parser = argparse.ArgumentParser(description="QQ 群管理工具（基于 NapCat / OneBot v11）")
    parser.add_argument("--host", default=cfg["server"]["host"])
    parser.add_argument("--port", type=int, default=cfg["server"]["port"])
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    args = parser.parse_args()

    if args.host not in ("127.0.0.1", "localhost"):
        parser.error("--host 仅支持 127.0.0.1 或 localhost")

    port = args.port
    if not _port_available(args.host, port):
        for candidate in range(port + 1, port + 20):
            if _port_available(args.host, candidate):
                print(f"[warn] 端口 {port} 被占用，改用 {candidate}")
                port = candidate
                break
        else:
            print(f"[error] {port} 及后续端口都被占用，请用 --port 指定")
            return 1

    router = api.build_router()
    httpd = server.serve(router, args.host, port)
    url = f"http://{args.host}:{port}/"

    active = config.active_profile(cfg)
    print("QQ 群管理工具已启动")
    print(f"  入口     : {url}")
    print(f"  协议端   : {active['name']} · {active['base_url']} · {active.get('adapter', 'napcat')}")
    print("  仅监听本机，关闭窗口或按 Ctrl+C 退出")

    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n正在退出…")
    finally:
        httpd.shutdown()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
