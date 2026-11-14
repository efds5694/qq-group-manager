import http.client
import threading
import unittest

from app.server import Router, serve


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        router = Router()
        router.add('POST', r'^/api/test$', lambda req: req.body)
        cls.server = serve(router, '127.0.0.1', 0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(2)

    def request(self, headers=None, body='{}', path='/api/test', method='POST'):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        try:
            conn.request(method, path, body=body, headers={'Content-Type': 'application/json', **(headers or {})})
            response = conn.getresponse()
            response.read()
            return response.status
        finally:
            conn.close()

    def test_same_origin_json_is_accepted(self):
        self.assertEqual(self.request({'Origin': f'http://127.0.0.1:{self.server.server_port}'}), 200)

    def test_cross_origin_is_rejected(self):
        self.assertEqual(self.request({'Origin': 'https://evil.example'}), 403)
        self.assertEqual(self.request({'Origin': 'null'}), 403)
        self.assertEqual(self.request({'Sec-Fetch-Site': 'cross-site'}), 403)

    def test_dns_rebinding_host_is_rejected(self):
        self.assertEqual(self.request({'Host': f'evil.example:{self.server.server_port}'}), 403)

    def test_plain_text_and_invalid_json_are_rejected(self):
        self.assertEqual(self.request({'Content-Type': 'text/plain'}), 415)
        self.assertEqual(self.request(body='{'), 400)
        self.assertEqual(self.request(body='[]'), 400)
        self.assertEqual(self.request({'Content-Length': '-1'}, body=None), 400)

    def test_private_files_and_traversal_are_not_served(self):
        for path in ('/config.json', '/data/cache/private.json', '/%2e%2e/run.py'):
            self.assertEqual(self.request(path=path, method='GET', body=None), 404)

    def test_non_loopback_bind_is_rejected(self):
        with self.assertRaises(ValueError):
            serve(Router(), '0.0.0.0', 0)
