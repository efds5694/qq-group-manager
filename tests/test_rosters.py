import base64
import csv
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app import api
from app.core import exporter, store
from app.core.errors import AppError
from app.server import Request
from app.services import members, results, rosters


def request(body=None):
    return Request('POST', '/', {}, body or {}, {})


def person(qq, **extra):
    return members.normalize({'user_id': str(qq), 'nickname': f'昵称{qq}', 'card': '', **extra})


class ImportTests(unittest.TestCase):
    def test_exported_csv_and_copied_tsv_preserve_columns_and_deduplicate_by_qq(self):
        header = ['群显示名', '昵称', 'QQ号', '群昵称', '自定义列']
        rows = [['来源群A', '张三,同学', '123456', '', '带换行\n的内容'],
                ['来源群B', '张三', '123456', '26级-张三', '第二条'],
                ['来源群A', '李四', '234567', '李四', '保留']]
        for raw in (exporter.rows_to_csv(header, rows), exporter.rows_to_tsv(header, rows)):
            with self.subTest(raw=raw[:20]):
                data = rosters.parse({'text': raw.decode('utf-8-sig')})
                self.assertEqual(data['header'], header)
                self.assertEqual(data['qq_index'], 2)
                self.assertEqual(data['duplicates'], 1)
                self.assertEqual([row['qq'] for row in data['members']], ['123456', '234567'])
                self.assertEqual(data['members'][0]['cells'][1:4], ['张三,同学', '123456', '26级-张三'])

    def test_utf8_bom_file_and_qq_only_roster(self):
        raw = exporter.rows_to_csv(['QQ号'], [['123456'], ['234567']])
        data = rosters.parse({'filename': '名单.csv', 'file_base64': base64.b64encode(raw).decode()})
        self.assertEqual(len(data['members']), 2)
        self.assertIsNone(data['members'][0]['present'])

    def test_invalid_rows_and_missing_qq_header_are_reported(self):
        for text, expected in [('昵称\n张三', 'QQ号'), ('QQ号,昵称\n1.23E+8,张三', '第 2 行'),
                               ('QQ号,昵称\n123,张三\n坏号,李四', '第 3 行'),
                               ('QQ号,昵称\n123,张三,多余', '列数'), ('QQ号,昵称', '没有有效成员'),
                               ('QQ号,QQ\n123,123', 'QQ号'), ('QQ号\n0', 'QQ号'),
                               ('QQ号,昵称\n123,"未结束', '格式无效')]:
            with self.subTest(text=text), self.assertRaisesRegex(AppError, expected):
                rosters.parse({'text': text})

    def test_xlsx_export_roundtrip_and_numeric_qq(self):
        raw = exporter.rows_to_xlsx(['昵称', 'QQ号', '群昵称'], [['张三', '123456789', '26级-张三']])
        if raw is None:
            self.skipTest('未安装 openpyxl')
        data = rosters.parse({'filename': '名单.xlsx', 'file_base64': base64.b64encode(raw).decode()})
        self.assertEqual(data['members'][0]['qq'], '123456789')
        self.assertEqual(data['members'][0]['cells'], ['张三', '123456789', '26级-张三'])
        from openpyxl import Workbook
        workbook = Workbook()
        workbook.active.append(['QQ号', '昵称'])
        workbook.active.append([234567890, '李四'])
        buffer = io.BytesIO()
        workbook.save(buffer)
        data = rosters.parse({'filename': '数字.xlsx', 'file_base64': base64.b64encode(buffer.getvalue()).decode()})
        self.assertEqual(data['members'][0]['qq'], '234567890')

    def test_bad_file_and_optional_xlsx_dependency_have_clear_errors(self):
        for payload in ({'filename': '名单.xls', 'file_base64': 'YWJj'},
                        {'filename': '名单.csv', 'file_base64': '???'},
                        {'filename': '名单.csv', 'file_base64': base64.b64encode(b'\xff\xfe').decode()},
                        {'filename': '名单.xlsx', 'file_base64': 'YWJj'}):
            with self.subTest(payload=payload), self.assertRaises(AppError):
                rosters.parse(payload)
        with patch.dict('sys.modules', {'openpyxl': None}), self.assertRaisesRegex(AppError, 'openpyxl'):
            rosters.parse({'filename': '名单.xlsx', 'file_base64': 'YWJj'})


class TrackingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        patcher = patch.object(store, 'DATA_DIR', Path(temporary.name))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.account = '99'
        self.client = Mock(cache_namespace='roster-tests')
        self.client.call.return_value = {'group_name': '活动群'}
        self.plan = rosters.create(self.account, {'name': '活动名单', 'text': '昵称,QQ号,群昵称\n张三,123456,26级-张三\n李四,234567,李四'})

    def entry(self, timestamp, qqs):
        return {'fetched_at': timestamp, 'members': [person('99'), *[person(qq, card='新群昵称', join_time=50) for qq in qqs]]}

    def bind(self, timestamp=100, qqs=('123456',), group_id='10000'):
        with patch.object(members, 'fetch', return_value=self.entry(timestamp, qqs)) as fetch:
            summary = rosters.bind(self.client, self.account, self.plan['id'], group_id)
            fetch.assert_called_once_with(self.client, group_id, force=True)
            return summary

    def sync(self, timestamp, qqs):
        with patch.object(members, 'fetch', return_value=self.entry(timestamp, qqs)) as fetch:
            summary = rosters.sync(self.client, self.account, self.plan['id'])
            fetch.assert_called_once_with(self.client, '10000', force=True)
            return summary

    def test_initial_unknown_and_persistence_are_account_isolated(self):
        self.assertEqual((self.plan['unknown'], self.plan['not_joined']), (2, 0))
        self.assertEqual(rosters.list_rosters('99')[0]['name'], '活动名单')
        self.assertEqual(rosters.list_rosters('100'), [])
        self.assertEqual(len(rosters.load('99', self.plan['id'])['members']), 2)
        with self.assertRaises(AppError):
            rosters.load('100', self.plan['id'])
        with self.assertRaises(AppError):
            rosters.sync(self.client, '99', self.plan['id'])
        self.client.call.assert_not_called()

    def test_join_leave_and_rejoin_keep_first_observation_and_latest_presence(self):
        bound = self.bind()
        self.assertEqual((bound['joined'], bound['missing'], bound['unknown']), (1, 1, 0))
        self.client.call.assert_called_once_with('get_group_info', group_id='10000', no_cache=True)
        changed = self.sync(200, ['234567'])
        self.assertEqual((changed['joined'], changed['left'], changed['not_joined']), (1, 1, 1))
        roster = rosters.load('99', self.plan['id'])
        self.assertEqual(roster['members'][0]['first_seen'], 100)
        self.assertEqual(roster['members'][0]['last_seen'], 100)
        self.assertEqual(roster['members'][1]['first_seen'], 200)
        result = rosters.build(roster, {'status': 'not_joined'})
        self.assertEqual(result['items'][0]['status'], 'left')
        self.assertEqual(result['items'][0]['values']['roster.current_card'], '')
        self.sync(300, ['123456', '234567'])
        roster = rosters.load('99', self.plan['id'])
        self.assertEqual(roster['members'][0]['first_seen'], 100)
        self.assertEqual(roster['members'][0]['last_seen'], 300)
        result = rosters.build(roster, {})
        self.assertEqual(result['items'][0]['values']['roster.current_card'], '新群昵称')
        self.assertEqual(result['items'][0]['values']['roster.join_time'], 50)
        self.assertEqual(result['items'][0]['display']['roster.first_seen'], '1970-01-01 08:01:40')

    def test_read_failure_preserves_states_and_checked_time_and_saves_error(self):
        self.bind()
        before = rosters.load('99', self.plan['id'])
        with patch.object(members, 'fetch', side_effect=AppError('连接已断开')), self.assertRaises(AppError):
            rosters.sync(self.client, '99', self.plan['id'])
        after = rosters.load('99', self.plan['id'])
        self.assertEqual(after['members'], before['members'])
        self.assertEqual(after['checked_at'], 100)
        self.assertEqual(after['last_error'], '连接已断开')
        self.sync(200, ['123456'])
        self.assertEqual(rosters.load('99', self.plan['id'])['last_error'], '')

    def test_empty_or_incomplete_member_list_is_not_treated_as_everyone_missing(self):
        self.bind()
        for actual in ([], [person('123456')], [person('99'), person('')]):
            with patch.object(members, 'fetch', return_value={'fetched_at': 200, 'members': actual}), self.assertRaisesRegex(AppError, '完整'):
                rosters.sync(self.client, '99', self.plan['id'])
        after = rosters.load('99', self.plan['id'])
        self.assertEqual(after['checked_at'], 100)
        self.assertEqual(rosters.summary(after)['joined'], 1)

    def test_rebinding_another_group_resets_observations_but_same_group_keeps_them(self):
        self.bind()
        self.bind(timestamp=200)
        self.assertEqual(rosters.load('99', self.plan['id'])['members'][0]['first_seen'], 100)
        self.bind(timestamp=300, group_id='20000')
        roster = rosters.load('99', self.plan['id'])
        self.assertEqual(roster['members'][0]['first_seen'], 300)
        self.assertEqual(roster['members'][0]['last_seen'], 300)
        self.assertIsNone(roster['members'][1]['first_seen'])

    def test_failed_bind_preserves_previous_target_and_progress(self):
        self.bind()
        before = rosters.load('99', self.plan['id'])
        with patch.object(members, 'fetch', side_effect=AppError('无法读取新群')), self.assertRaises(AppError):
            rosters.bind(self.client, '99', self.plan['id'], '20000')
        self.assertEqual(rosters.load('99', self.plan['id']), before)

    def test_late_sync_cannot_overwrite_newer_observation_or_new_target(self):
        self.bind()
        self.sync(300, ['234567'])
        self.sync(200, ['123456'])
        self.assertEqual(rosters.load('99', self.plan['id'])['checked_at'], 300)

        def changed_target(*args, **kwargs):
            roster = rosters.load('99', self.plan['id'])
            roster['group_id'] = '20000'
            store.write_json(rosters._path('99', self.plan['id']), roster)
            return self.entry(400, ['123456'])
        with patch.object(members, 'fetch', side_effect=changed_target), self.assertRaisesRegex(AppError, '目标群已变更'):
            rosters.sync(self.client, '99', self.plan['id'])
        self.assertEqual(rosters.load('99', self.plan['id'])['checked_at'], 300)

    def test_filters_search_and_sort_use_all_imported_columns(self):
        self.bind()
        roster = rosters.load('99', self.plan['id'])
        self.assertEqual([row['qq'] for row in rosters.build(roster, {'status': 'joined'})['items']], ['123456'])
        self.assertEqual([row['qq'] for row in rosters.build(roster, {'search': '李四'})['items']], ['234567'])
        self.assertEqual([row['qq'] for row in rosters.build(roster, {'search': '新群昵称'})['items']], ['123456'])
        self.assertEqual([row['qq'] for row in rosters.build(roster, {'sort': {'field': 'member.qq', 'desc': True}})['items']], ['234567', '123456'])
        with self.assertRaises(AppError):
            rosters.build(roster, {'status': 'invalid'})
        with self.assertRaises(AppError):
            rosters.build(roster, {'sort': {'field': 'bad'}})

    def test_local_deletion_and_invalid_import_do_not_modify_qq(self):
        with self.assertRaises(AppError):
            rosters.create('99', {'name': '坏名单', 'text': 'QQ号\ninvalid'})
        self.assertEqual(len(rosters.list_rosters('99')), 1)
        rosters.delete('99', self.plan['id'])
        self.assertEqual(rosters.list_rosters('99'), [])
        with self.assertRaises(AppError):
            rosters.load('99', '../config')
        self.client.call.assert_not_called()


class RosterApiTests(unittest.TestCase):
    def test_preview_and_export_cover_all_rows_and_selected_range(self):
        own = ('test-namespace', '99')
        client = SimpleNamespace(cache_namespace=own[0])
        with patch.object(api, '_session', return_value={'login': {'user_id': own[1]}}), \
                patch.object(api, '_active_client', return_value=(client, {})), \
                patch.object(results, 'STORE', results.ResultStore()):
            body = {'text': '昵称,QQ号,群昵称\n' + '\n'.join(f'同学{i},{100000+i},名单昵称{i}' for i in range(550))}
            preview = api.api_roster_import(request(body))
            self.assertEqual(preview['total'], 550)
            self.assertEqual(len(preview['items']), 200)
            self.assertEqual(preview['roster']['unknown'], 550)
            exported = api.api_query_export(request({'query_id': preview['query_id'], 'format': 'csv'}))
            rows = list(csv.reader(io.StringIO(exported.body.decode('utf-8-sig'))))
            self.assertEqual(len(rows), 551)
            self.assertIn('群昵称', rows[0])
            self.assertIn('入群状态', rows[0])
            self.assertEqual(rows[-1][0], '100549')
            exported = api.api_query_export(request({'query_id': preview['query_id'], 'format': 'csv', 'selected': ['100549']}))
            rows = list(csv.reader(io.StringIO(exported.body.decode('utf-8-sig'))))
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[1][0], '100549')
            self.assertEqual(len(rosters.parse({'text': exported.body.decode('utf-8-sig')})['members']), 1)

    def test_saved_roster_query_uses_current_account(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(store, 'DATA_DIR', Path(temporary)), \
                patch.object(api, '_session', return_value={'login': {'user_id': '99'}}) as session, \
                patch.object(api, '_active_client', return_value=(SimpleNamespace(cache_namespace='api-tests'), {})), \
                patch.object(results, 'STORE', results.ResultStore()):
            created = api.api_roster_create(request({'name': '测试', 'text': 'QQ号\n123456'}))
            self.assertEqual(api.api_rosters(request())['rosters'][0]['id'], created['id'])
            self.assertEqual(api.api_roster_query(request(), created['id'])['total'], 1)
            session.return_value = {'login': {'user_id': '100'}}
            with self.assertRaises(AppError):
                api.api_roster_query(request(), created['id'])
            session.return_value = {'login': {'user_id': '99'}}
            self.assertTrue(api.api_roster_delete(request(), created['id'])['deleted'])


if __name__ == '__main__':
    unittest.main()
