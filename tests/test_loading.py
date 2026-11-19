import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from app import api
from app.core import store
from app.core.errors import AppError
from app.server import Request
from app.services import groups, jobs, members, results


def wait_job(manager, job_id):
    end = time.monotonic() + 2
    while time.monotonic() < end:
        job = manager.get(job_id)
        if job['status'] in ('done', 'failed', 'canceled'):
            return job
        time.sleep(.002)
    raise AssertionError('读取任务未结束')


class LoadingTests(unittest.TestCase):
    def test_async_query_publishes_progress_then_full_selection_without_reloading(self):
        manager = jobs.JobManager()
        entered, release = threading.Event(), threading.Event()
        result = {'items': [{'id':str(i)} for i in range(450)], 'total':450,
                  'columns':[], 'fields':[], 'groups':[]}
        def prepare(spec, progress):
            progress('读取群身份', 26, 103)
            entered.set()
            if not release.wait(2):
                raise AssertionError('读取未释放')
            return {'entity':'groups'}, None
        with patch.object(api, '_active_client', return_value=(None, {})), \
                patch.object(api, '_query_data', side_effect=prepare) as read, \
                patch.object(api.query, 'execute', return_value=result), \
                patch.object(api, '_result_owner', return_value=('test','99')), \
                patch.object(results, 'STORE', results.ResultStore()), \
                patch.object(api.jobs, 'MANAGER', manager):
            request = Request('POST','/',{}, {'entity':'groups','background':True}, {})
            pending = api.api_query_start(request)
            try:
                self.assertTrue(pending['pending'])
                self.assertTrue(entered.wait(1))
                self.assertEqual(manager.get(pending['job']['id'])['cursor'], 26)
            finally:
                release.set()
            done = wait_job(manager, pending['job']['id'])
            self.assertEqual(done['status'], 'done')
            self.assertEqual(len(done['result']['items']), 200)
            selection = api.api_result_selection(request, done['result']['query_id'])
            self.assertEqual(selection['ids'], [str(i) for i in range(450)])
            read.assert_called_once()

    def test_read_progress_and_result_are_visible_while_write_queue_is_busy(self):
        manager = jobs.JobManager()
        write_started, write_release = threading.Event(), threading.Event()
        read_started, read_release = threading.Event(), threading.Event()

        class Client:
            def call(self, action, **params):
                write_started.set()
                if not write_release.wait(2):
                    raise AssertionError('write timeout')

        def read(progress):
            progress('读取群身份', 26, 103)
            read_started.set()
            if not read_release.wait(2):
                raise AssertionError('read timeout')
            return {'groups': ['a', 'b']}

        with patch.object(store, 'log_event'), patch.object(jobs.random, 'uniform', return_value=0):
            manager.submit(Client(), 'settings', [{'action': 'write', 'params': {}}], title='写任务', interval=0)
            try:
                self.assertTrue(write_started.wait(1))
                job = manager.submit(None, 'load', [{'action': 'read', 'run': read}], title='读取', interval=0)
                self.assertTrue(read_started.wait(1))
                current = manager.get(job['id'])
                self.assertEqual((current['phase'], current['cursor'], current['total']), ('读取群身份', 26, 103))
                self.assertEqual(current['status'], 'running')
                read_release.set()
                finished = wait_job(manager, job['id'])
                self.assertEqual(finished['result'], {'groups': ['a', 'b']})
                self.assertEqual(finished['status'], 'done')
            finally:
                write_release.set()
                read_release.set()
            manager._queue.join()

    def test_read_errors_and_cancellation_remain_errors_instead_of_empty_results(self):
        manager = jobs.JobManager()
        def read(progress):
            raise AppError('成员读取失败', code='NETWORK', hint='检查连接')
        job = manager.submit(None, 'load', [{'action': 'read', 'run': read}], title='读取', interval=0)
        failed = wait_job(manager, job['id'])
        self.assertEqual(failed['status'], 'failed')
        self.assertEqual((failed['error'], failed['error_code'], failed['hint']), ('成员读取失败', 'NETWORK', '检查连接'))
        entered, release = threading.Event(), threading.Event()
        def cancelable(progress):
            entered.set()
            release.wait(2)
            progress('下一群', 1, 2)
        job = manager.submit(None, 'load', [{'action': 'read', 'run': cancelable}], title='读取', interval=0)
        try:
            self.assertTrue(entered.wait(1))
            manager.cancel(job['id'])
        finally:
            release.set()
        self.assertEqual(wait_job(manager, job['id'])['status'], 'canceled')

    def test_member_progress_reports_completed_groups_even_if_first_group_is_slow(self):
        release = threading.Event()
        stages = []
        def fetch(client, gid, force):
            if gid == 'slow' and not release.wait(1):
                raise AssertionError('应先报告已经完成的 fast 群')
            return {'fetched_at': 123, 'members': []}
        def progress(phase, current, total):
            stages.append((phase, current, total))
            if current == 1:
                release.set()
        with patch.object(members, 'fetch', side_effect=fetch):
            entries, errors = members.fetch_many(None, ['slow', 'fast'], on_progress=progress)
        self.assertFalse(errors)
        self.assertEqual(set(entries), {'slow', 'fast'})
        self.assertEqual([current for _, current, _ in stages], [0, 1, 2])

    def test_group_read_time_is_response_time_and_role_progress_is_reported(self):
        clock = [100]
        class Client:
            cache_namespace = 'loading-test'
            def call(self, action, **params):
                if action == 'get_group_list':
                    clock[0] = 200
                    return [{'group_id': gid, 'group_name': gid} for gid in ('10', '20', '30')]
                return {'role': 'owner'}
        stages = []
        with tempfile.TemporaryDirectory() as tmp, patch.object(store, 'CACHE_DIR', Path(tmp)), \
                patch.dict(groups._CACHE, clear=True), patch.dict(groups._META, clear=True), \
                patch.object(groups.time, 'time', side_effect=lambda: clock[0]):
            listing = groups.list_groups(Client(), '99', on_progress=lambda *args: stages.append(args))
        self.assertTrue(all(group['fetched_at'] == 200 for group in listing))
        roles = [stage for stage in stages if stage[0] == '读取各群管理身份']
        self.assertEqual([stage[1] for stage in roles], [0, 1, 2, 3])

