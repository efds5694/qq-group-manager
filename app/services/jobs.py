"""批量任务队列。

写任务由单工作线程串行执行，天然限速；前端每秒轮询进度。
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
                            if task["action"] in ("set_group_card", "set_group_admin", "set_group_kick", "set_group_ban")}:
                    members.expire(client, gid)
                if self._jobs[job_id]["kind"] == "settings":
                    from . import groups
                    groups.invalidate()
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

        if kind == "load":
            threading.Thread(target=self._run_read, args=(job_id, tasks[0]["run"], cancel_flag),
                             name=f"read-{job_id}", daemon=True).start()
        else:
            self._queue.put((job_id, client, tasks, cancel_flag))
        return self.get(job_id)

    def _run_read(self, job_id, work, cancel):
        """耗时读取在独立线程运行，复用任务查询，不阻塞串行写队列。"""
        with self._lock:
            job = self._jobs[job_id]
            job.update(status="running", started_at=time.time(), total=0)

        def progress(phase, current=0, total=0):
            if cancel.is_set():
                from ..core.errors import AppError
                raise AppError("资料读取已中止", code="CANCELED")
            with self._lock:
                job.update(phase=phase, cursor=current, ok=current, total=total)

        try:
            result = work(progress)
            with self._lock:
                job.update(status="canceled" if cancel.is_set() else "done", result=result,
                           finished_at=time.time())
                if not cancel.is_set():
                    total = job["total"] or 1
                    job.update(phase="资料读取完成", total=total, cursor=total, ok=total)
        except Exception as exc:
            with self._lock:
                job.update(status="canceled" if cancel.is_set() else "failed", finished_at=time.time(),
                           error=getattr(exc, "message", None) or str(exc),
                           error_code=getattr(exc, "code", "APP_ERROR"), hint=getattr(exc, "hint", ""))

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
            skipped = False
            message = ""
            for attempt in range(retries + 1):
                try:
                    reason = task["run"]() if "run" in task else None
                    if "run" not in task:
                        client.call(task["action"], **task["params"])
                    skipped = bool(reason)
                    ok = not skipped
                    message = reason or ""
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
                if skipped:
                    job["skipped"] += 1
                elif ok:
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
                            "skipped": skipped,
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
                    "skipped": job["skipped"],
                    "cursor": job["cursor"],
                    "phase": job.get("phase", ""),
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
