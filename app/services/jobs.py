"""批量任务队列。

单工作线程串行执行，天然限速；前端每 400ms 轮询进度。
线程而不是 asyncio：标准库环境下更可控，也不会和 HTTP 服务抢事件循环。
"""

from __future__ import annotations

import queue
import random
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

from ..core import store
from . import members

MAX_ITEMS = 5000


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, dict] = {}
        self._cancel_flags: dict[str, threading.Event] = {}
        self._lock = threading.Lock()
        self._queue = queue.Queue()
        threading.Thread(target=self._worker, name="job-worker", daemon=True).start()

    def _worker(self) -> None:
        while True:
            job_id, client, tasks, cancel = self._queue.get()
            try:
                self._run(job_id, client, tasks, cancel)
            except Exception:
                with self._lock:
                    self._jobs[job_id].update(status="failed", error="任务执行异常", finished_at=time.time())
            finally:
                for gid in {str(task["params"]["group_id"]) for task in tasks
                            if task["action"] == "set_group_card"}:
                    members.expire(client, gid)
                self._queue.task_done()

    # ------------------------------------------------------------- 创建任务
    def submit(
        self,
        client,
        kind: str,
        tasks: list[dict],
        *,
        title: str,
        interval: float = 2.0,
        retries: int = 2,
        meta: dict | None = None,
    ) -> dict:
        if not tasks:
            from ..core.errors import AppError

            raise AppError("没有可执行的操作", hint="先预演确认有差异，再执行。")

        job_id = uuid.uuid4().hex[:12]
        job = {
            "id": job_id,
            "kind": kind,
            "title": title,
            "status": "pending",
            "total": len(tasks),
            "ok": 0,
            "fail": 0,
            "skipped": 0,
            "cursor": 0,
            "interval": float(interval),
            "retries": int(retries),
            "eta_seconds": int(len(tasks) * float(interval)),
            "created_at": time.time(),
            "started_at": None,
            "finished_at": None,
            "error": None,
            "meta": meta or {},
            "items": [],
        }
        cancel_flag = threading.Event()
        with self._lock:
            self._jobs[job_id] = job
            self._cancel_flags[job_id] = cancel_flag

        self._queue.put((job_id, client, tasks, cancel_flag))
        return self.get(job_id)

    # ------------------------------------------------------------- 执行循环
    def _run(self, job_id: str, client, tasks: list[dict], cancel: threading.Event) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job["status"] = "running"
            job["started_at"] = time.time()

        interval = job["interval"]
        retries = job["retries"]
        if job["kind"] == "collect":
            self._run_collection(job, tasks, cancel)
            return

        for index, task in enumerate(tasks):
            if cancel.is_set():
                with self._lock:
                    job["status"] = "canceled"
                    job["finished_at"] = time.time()
                store.log_event(
                    "job_canceled",
                    job=job_id,
                    job_kind=job["kind"],
                    ok=job["ok"],
                    fail=job["fail"],
                    done=job["cursor"],
                    total=job["total"],
                )
                return

            started = time.perf_counter()
            ok = False
            message = ""
            for attempt in range(retries + 1):
                try:
                    client.call(task["action"], **task["params"])
                    ok = True
                    message = ""
                    break
                except Exception as exc:  # 单条失败不影响整批
                    message = getattr(exc, "message", None) or str(exc)
                    hint = getattr(exc, "hint", None)
                    if hint:
                        message = f"{message}（{hint}）"
                    if attempt < retries:
                        time.sleep(min(interval * (2**attempt), 15) + random.uniform(0, 0.4))

            elapsed_ms = int((time.perf_counter() - started) * 1000)
            with self._lock:
                job["cursor"] = index + 1
                if ok:
                    job["ok"] += 1
                else:
                    job["fail"] += 1
                remaining = job["total"] - job["cursor"]
                job["eta_seconds"] = int(remaining * interval)
                if len(job["items"]) < MAX_ITEMS:
                    job["items"].append(
                        {
                            "seq": index + 1,
                            "target": task.get("target", ""),
                            "label": task.get("label", ""),
                            "action": task["action"],
                            "ok": ok,
                            "message": message[:200],
                            "ms": elapsed_ms,
                        }
                    )

            # 最后一条后也等待，保证不同任务之间仍遵守限速。
            time.sleep(interval + random.uniform(0, 0.5))

        with self._lock:
            job["status"] = "done" if job["fail"] == 0 else "failed"
            job["finished_at"] = time.time()
            job["eta_seconds"] = 0
            summary = {
                "job": job_id,
                "job_kind": job["kind"],
                "total": job["total"],
                "ok": job["ok"],
                "fail": job["fail"],
                "elapsed": int(job["finished_at"] - (job["started_at"] or job["finished_at"])),
                "group_id": job["meta"].get("group_id"),
            }

        store.log_event("job_finished", **summary)

    def _run_collection(self, job, tasks, cancel):
        def run(task):
            if cancel.is_set():
                return None
            started = time.perf_counter()
            try:
                task["run"]()
                return True, "", int((time.perf_counter() - started) * 1000)
            except Exception as exc:
                return False, getattr(exc, "message", None) or str(exc), int((time.perf_counter() - started) * 1000)

        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(run, task): task for task in tasks}
            for future in as_completed(futures):
                result = future.result()
                if result is None:
                    continue
                ok, message, elapsed = result
                task = futures[future]
                with self._lock:
                    job["cursor"] += 1
                    job["ok" if ok else "fail"] += 1
                    if len(job["items"]) < MAX_ITEMS:
                        job["items"].append({"seq": job["cursor"], "target": task["target"], "label": task["label"],
                                             "action": task["action"], "ok": ok, "message": message[:200], "ms": elapsed})
        with self._lock:
            job["status"] = "canceled" if cancel.is_set() else "failed" if job["fail"] else "done"
            job["finished_at"] = time.time()
        store.log_event("collection_finished", job=job["id"], total=job["total"], ok=job["ok"], fail=job["fail"])

    # ------------------------------------------------------------- 查询与控制
    def get(self, job_id: str) -> dict:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                from ..core.errors import AppError

                raise AppError("任务不存在", hint="可能已重启服务，任务记录已清空。", status=404)
            snapshot = dict(job)
            snapshot["items"] = list(job["items"])
            return snapshot

    def list(self, limit: int = 30) -> list[dict]:
        with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda item: item["created_at"], reverse=True)[:limit]
            return [
                {
                    "id": job["id"],
                    "kind": job["kind"],
                    "title": job["title"],
                    "status": job["status"],
                    "total": job["total"],
                    "ok": job["ok"],
                    "fail": job["fail"],
                    "created_at": job["created_at"],
                    "created_text": time.strftime("%H:%M:%S", time.localtime(job["created_at"])),
                }
                for job in jobs
            ]

    def cancel(self, job_id: str) -> dict:
        flag = self._cancel_flags.get(job_id)
        if not flag:
            from ..core.errors import AppError

            raise AppError("任务不存在或已结束", status=404)
        flag.set()
        return self.get(job_id)


MANAGER = JobManager()
