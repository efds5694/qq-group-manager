"""短期、账号隔离的查询结果。窗口读取不重新拉取、筛选成员。"""
from __future__ import annotations

import copy
import threading
import time
import uuid
from collections import OrderedDict

from ..core.errors import AppError

WINDOW = 200
MAX_RESULTS = 8
IDLE_SECONDS = 30 * 60


class ResultStore:
    def __init__(self):
        self._items = OrderedDict()
        self._lock = threading.RLock()

    def _prune(self):
        now = time.time()
        for key in list(self._items):
            if now - self._items[key]["accessed_at"] >= IDLE_SECONDS:
                del self._items[key]

    def create(self, owner, result, spec):
        result = copy.deepcopy(result)
        rows = []
        previous = object()
        for index, item in enumerate(result["items"]):
            bucket = item.get("bucket")
            if "bucket" in item and bucket != previous:
                rows.append({"kind": "group", "id": f"bucket:{index}", "label": bucket,
                             "count": result.get("buckets", {}).get(bucket, 0)})
                previous = bucket
            rows.append({**item, "kind": "record", "position": index + 1})
        key = uuid.uuid4().hex
        with self._lock:
            self._prune()
            self._items[key] = {"owner": owner, "result": result, "rows": rows,
                                "spec": copy.deepcopy(spec), "created_at": time.time(), "accessed_at": time.time()}
            while len(self._items) > MAX_RESULTS:
                self._items.popitem(last=False)
        return self.window(owner, key)

    def get(self, owner, key):
        with self._lock:
            self._prune()
            entry = self._items.get(key)
            if not entry or entry["owner"] != owner:
                raise AppError("查询结果已失效", code="QUERY_EXPIRED", status=410,
                               hint="已有画面和勾选已保留，请点击重新加载。")
            entry["accessed_at"] = time.time()
            self._items.move_to_end(key)
            return entry

    def window(self, owner, key, offset=0, limit=WINDOW):
        entry = self.get(owner, key)
        try:
            offset = max(0, int(offset))
            limit = max(1, min(WINDOW, int(limit)))
        except (TypeError, ValueError) as exc:
            raise AppError("列表读取位置无效") from exc
        metadata = {name: val for name, val in entry["result"].items() if name not in ("items", "page", "pages", "size")}
        return {**metadata, "query_id": key, "total_rows": len(entry["rows"]), "offset": offset,
                "created_at": entry["created_at"], "items": entry["rows"][offset:offset+limit]}


STORE = ResultStore()
