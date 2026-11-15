"""按账号、群、接口保存完整只读资料。补全任务复用任务中心。"""
from __future__ import annotations

import threading
import time

from ..core import store
from ..core.errors import AppError, UnsupportedAction
from . import jobs

GROUP_ACTIONS = ("get_group_info", "get_group_detail_info", "get_group_info_ex", "get_group_shut_list",
                 "get_group_honor_info", "get_group_at_all_remain")
_LOCK = threading.RLock()


def path(client, gid):
    safe = "".join(char for char in str(gid) if char.isdigit())
    return store.CACHE_DIR / f"details-{client.cache_namespace}-{safe}.json"


def load(client, gid):
    return store.read_json(path(client, gid), {}) or {}


def fetch(client, gid, action, qq=None):
    params = {"group_id": str(gid)}
    if qq:
        params.update(user_id=str(qq), no_cache=True)
    if action == "get_group_honor_info":
        params["type"] = "all"
    try:
        data = client.call(action, timeout=30, **params)
        result = {"status": "ok", "data": data, "at": time.time()}
    except Exception as exc:
        result = {"status": "unsupported" if isinstance(exc, UnsupportedAction) else "failed",
                  "error": getattr(exc, "message", None) or str(exc), "at": time.time()}
        data = None
        error = exc
    with _LOCK:
        cached = load(client, gid)
        target = cached.setdefault("members", {}).setdefault(str(qq), {}) if qq else cached.setdefault("group", {})
        previous = target.get(action, {})
        if result["status"] != "ok" and ("data" in previous or "previous_data" in previous):
            result["previous_data"] = previous.get("data", previous.get("previous_data"))
            result["previous_at"] = previous.get("at") if "data" in previous else previous.get("previous_at")
        target[action] = result
        store.write_json(path(client, gid), cached)
    if result["status"] != "ok":
        raise error
    return data


def tasks(client, entries, group_ids, *, retry_failed=False, required_only=False, include_members=True, include_group=True):
    result = []
    for gid in group_ids:
        cached = load(client, gid)
        calls = [(action, None) for action in GROUP_ACTIONS] if include_group else []
        if include_members:
            calls += [("get_group_member_info", member["qq"]) for member in entries.get(gid, {}).get("members", [])]
        for action, qq in calls:
            previous = cached.get("members", {}).get(str(qq), {}).get(action, {}) if qq else cached.get("group", {}).get(action, {})
            if retry_failed and previous.get("status") != "failed":
                continue
            if required_only and previous:
                continue
            def run(gid=gid, action=action, qq=qq):
                return fetch(client, gid, action, qq)
            result.append({"action": action, "params": {"group_id": gid}, "run": run,
                           "target": str(qq or gid), "label": f"{gid} · {qq or '群资料'} · {action}"})
    return result


def submit(client, entries, group_ids, **options):
    work = tasks(client, entries, group_ids, **options)
    if not work:
        raise AppError("没有需要补全的资料", hint="所选范围已采集，或没有失败项需要重试。")
    return jobs.MANAGER.submit(client, "collect", work, title=f"补全资料 · {len(group_ids)} 个群 / {len(work)} 项",
                               interval=0, retries=0, meta={"group_ids": group_ids})
