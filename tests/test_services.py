import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from app.core import store
from app.onebot.client import OneBotClient
from app.services import jobs, members


class CacheTests(unittest.TestCase):
    def test_accounts_do_not_share_memory_or_disk_cache(self):
        class Client:
            def __init__(self, account):
                self.cache_namespace = account
                self.calls = 0

            def call(self, *args, **kwargs):
                self.calls += 1
                return [{'user_id': self.cache_namespace, 'nickname': self.cache_namespace}]

        a, b = Client('10001'), Client('10002')
        with tempfile.TemporaryDirectory() as tmp, patch.object(store, 'CACHE_DIR', Path(tmp)):
            members.invalidate()
            try:
                self.assertEqual(members.fetch(a, '123')['members'][0]['qq'], '10001')
                self.assertEqual(members.fetch(b, '123')['members'][0]['qq'], '10002')
                members.invalidate()
                with patch.object(members, '_refresh_async'):
                    self.assertEqual(members.fetch(a, '123')['members'][0]['qq'], '10001')
                    self.assertEqual(members.fetch(b, '123')['members'][0]['qq'], '10002')
                self.assertEqual((a.calls, b.calls), (1, 1))
            finally:
                members.invalidate()

    def test_connection_namespace_contains_no_token(self):
        a = OneBotClient('http://127.0.0.1:3000', 'private-token-A')
        b = OneBotClient('http://127.0.0.1:3000', 'private-token-B')
        self.assertNotEqual(a.cache_namespace, b.cache_namespace)
        self.assertNotIn('private-token', a.cache_namespace)

    def test_same_endpoint_is_isolated_by_login_account(self):
        a = OneBotClient('http://127.0.0.1:3000', 'same-token')
        b = OneBotClient('http://127.0.0.1:3000', 'same-token')
        with patch.object(a, 'call', return_value={'user_id': 10001}):
            a.ping()
        with patch.object(b, 'call', return_value={'user_id': 10002}):
            b.ping()
        self.assertNotEqual(a.cache_namespace, b.cache_namespace)


class JobTests(unittest.TestCase):
    def test_jobs_run_serially_and_queued_job_can_be_canceled(self):
        manager = jobs.JobManager()
        entered, release, second_entered = threading.Event(), threading.Event(), threading.Event()
        calls = []

        class Client:
            def call(self, action, **params):
                calls.append(action)
                if action == 'first':
                    entered.set()
                    if not release.wait(3):
                        raise RuntimeError('test timed out')
                else:
                    second_entered.set()

        def submit(action):
            return manager.submit(Client(), 'test', [{'action': action, 'params': {}}], title=action, interval=0, retries=0)

        with patch.object(store, 'log_event'), patch.object(jobs.random, 'uniform', return_value=0):
            first = submit('first')
            try:
                self.assertTrue(entered.wait(2))
                canceled = submit('canceled')
                second = submit('second')
                self.assertFalse(second_entered.wait(.1))
                self.assertEqual(manager.get(second['id'])['status'], 'pending')
                manager.cancel(canceled['id'])
            finally:
                release.set()
            manager._queue.join()
            self.assertEqual(calls, ['first', 'second'])
            self.assertEqual(manager.get(first['id'])['status'], 'done')
            self.assertEqual(manager.get(canceled['id'])['status'], 'canceled')
            self.assertEqual(manager.get(second['id'])['status'], 'done')
