"""本地持久化：快照、审计日志、原子 JSON 读写。

所有写入都保证原子性（临时文件 + os.replace），
这样批量任务被中断时也不会留下半个损坏的 JSON。
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "data"
SNAPSHOT_DIR = DATA_DIR / "snapshots"
LOG_DIR = DATA_DIR / "logs"
CACHE_DIR = DATA_DIR / "cache"

_LOCK = threading.Lock()


def ensure_dirs() -> None:
    for path in (DATA_DIR, SNAPSHOT_DIR, LOG_DIR, CACHE_DIR):
        path.mkdir(parents=True, exist_ok=True)


def write_json(path: Path, payload: Any) -> None:
    """原子写 JSON。Windows 上 os.replace 可覆盖已存在文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def read_json(path: Path, default: Any = None) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return default


def _stamp() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


def save_snapshot(kind: str, group_id: str, payload: dict, note: str = "") -> dict:
    """保存一份快照，返回 {id, kind, group_id, created_at, count, note}。"""
    ensure_dirs()
    created = time.time()
    snap_id = f"{_stamp()}-{kind}-{group_id}"
    path = SNAPSHOT_DIR / f"{snap_id}.json"
    suffix = 1
    while path.exists():
        snap_id = f"{_stamp()}-{kind}-{group_id}-{suffix}"
        path = SNAPSHOT_DIR / f"{snap_id}.json"
        suffix += 1

    payload = dict(payload)
    payload.update(
        {
            "snapshot_id": snap_id,
            "kind": kind,
            "group_id": str(group_id),
            "created_at": created,
            "note": note,
        }
    )
    write_json(path, payload)

    count = 0
    if isinstance(payload.get("members"), list):
        count = len(payload["members"])
    elif isinstance(payload.get("entries"), list):
        count = len(payload["entries"])

    return {
        "id": snap_id,
        "kind": kind,
        "group_id": str(group_id),
        "created_at": created,
        "created_text": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(created)),
        "count": count,
        "note": note,
    }


def list_snapshots(limit: int = 60) -> list[dict]:
    ensure_dirs()
    files = sorted(SNAPSHOT_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    result: list[dict] = []
    for path in files[:limit]:
        data = read_json(path, {}) or {}
        count = len(data.get("members") or data.get("entries") or [])
        created = data.get("created_at") or path.stat().st_mtime
        result.append(
            {
                "id": data.get("snapshot_id") or path.stem,
                "kind": data.get("kind") or "unknown",
                "group_id": str(data.get("group_id") or ""),
                "group_name": data.get("group_name") or "",
                "created_at": created,
                "created_text": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(created)),
                "count": count,
                "note": data.get("note") or "",
            }
        )
    return result


def load_snapshot(snapshot_id: str) -> dict:
    path = SNAPSHOT_DIR / f"{snapshot_id}.json"
    data = read_json(path)
    if not data:
        from .errors import AppError

        raise AppError("快照不存在或已损坏", hint="刷新任务中心后重试。", status=404)
    return data


def log_event(kind: str, **fields: Any) -> None:
    """审计日志：一天一个 jsonl，绝不写入 token 与完整响应体。"""
    ensure_dirs()
    day = time.strftime("%Y-%m-%d")
    record = {"ts": time.strftime("%Y-%m-%d %H:%M:%S"), "kind": kind}
    record.update(fields)
    line = json.dumps(record, ensure_ascii=False)
    with _LOCK:
        with (LOG_DIR / f"{day}.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")


def recent_logs(limit: int = 200) -> list[dict]:
    ensure_dirs()
    files = sorted(LOG_DIR.glob("*.jsonl"), reverse=True)
    records: list[dict] = []
    for path in files:
        try:
            with path.open("r", encoding="utf-8") as handle:
                lines = handle.readlines()
        except OSError:
            continue
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
            if len(records) >= limit:
                return records
    return records
