import csv
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from app import api
from app.core import store
from app.core.errors import AppError
from app.server import Request
from app.services import cards, jobs, members


def member(qq, card='', role='member', nickname=None):
    return members.normalize({'user_id': qq, 'card': card, 'role': role,
                              'nickname': nickname or f'昵称{qq}', 'join_time': 1700000000})


def entry(gid, people):
    return {'group_id': gid, 'members': people, 'fetched_at': 1700000000}


def request(body=None, **query):
    return Request('POST' if body is not None else 'GET', '/',
                   {key: [str(value)] for key, value in query.items()}, body or {}, {})


class CrossMembersTests(unittest.TestCase):
    def setUp(self):
        self.entries = {
            's1': entry('s1', [member('1', '张三'), member('2', ''), member('3', '李四')]),
            's2': entry('s2', [member('1', '张同学'), member('2', '王五')]),
            't': entry('t', [member('1', '旧群昵称'), member('2', '王五'), member('4', '目标独有')]),
        }
        self.names = {'s1': '师生一', 's2': '师生二', 't': '课程群'}

    def query(self, **options):
        return members.common_members(self.entries, self.names, source_groups=['s1', 's2'], **options)

    def test_union_source_priority_and_counts(self):
        result = self.query()
        by_qq = {row['qq']: row for row in result['items']}
        self.assertEqual(set(by_qq), {'1', '2', '3', '4'})
        self.assertEqual(result['counts'], {'all': 4, 'single': 2, 'multiple': 2,
                                           'different': 1, 'no_reference': 1})
        self.assertEqual(by_qq['1']['reference_card'], '张三')
        self.assertEqual(by_qq['1']['source_group_id'], 's1')
        self.assertTrue(by_qq['1']['source_conflict'])
        self.assertEqual(by_qq['2']['reference_card'], '王五')
        self.assertEqual(by_qq['2']['source_group_id'], 's2')
        self.assertFalse(by_qq['4']['reference_card'])
        self.assertEqual([group['is_source'] for group in result['groups']], [True, True, False])
        reversed_sources = members.common_members(self.entries, self.names, source_groups=['s2', 's1'])
        self.assertEqual(reversed_sources['items'][0]['reference_card'], '张同学')

    def test_membership_modes_and_combined_conditions(self):
        self.assertEqual({row['qq'] for row in self.query(mode='single')['items']}, {'3', '4'})
        self.assertEqual({row['qq'] for row in self.query(mode='multiple')['items']}, {'1', '2'})
        self.assertEqual({row['qq'] for row in self.query(mode='intersection')['items']}, {'1', '2'})
        self.assertEqual([row['qq'] for row in self.query(in_groups=['s1'], not_in_groups=['t'])['items']], ['3'])
        self.assertEqual(self.query(in_groups=['t'], not_in_groups=['t'])['total'], 0)
        single = members.common_members({'t': self.entries['t']}, self.names)
        self.assertEqual(single['total'], 3)

    def test_search_status_selection_and_sort(self):
        self.assertEqual([row['qq'] for row in self.query(keyword='张同学')['items']], ['1'])
        self.assertEqual([row['qq'] for row in self.query(status='different')['items']], ['1'])
        self.assertEqual([row['qq'] for row in self.query(status='no_reference')['items']], ['4'])
        self.assertEqual([row['qq'] for row in self.query(selected=['1', '4'], sort='qq')['items']], ['1', '4'])
        self.assertEqual(self.query(selected=[])['total'], 0)
        self.assertEqual(self.query(keyword='不存在')['total'], 0)
        self.assertEqual([row['qq'] for row in self.query(sort='name')['items']], ['1', '4', '3', '2'])

    def test_pagination_and_export_have_no_5000_person_cutoff(self):
        entries = {'t': entry('t', [member(str(index)) for index in range(1, 5008)])}
        result = members.common_members(entries, {'t': '测试群'}, page=101)
        self.assertEqual(result['total'], 5007)
        self.assertEqual(result['pages'], 101)
        self.assertEqual(len(result['items']), 7)
        self.assertEqual(result['items'][-1]['qq'], '5007')
        with patch.object(api, '_common_context', return_value=(['t'], entries, {'t': '测试群'}, {})):
            response = api.api_export_common(request(groups='t', format='csv'))
        rows = list(csv.reader(io.StringIO(response.body.decode('utf-8-sig'))))
        self.assertEqual(len(rows), 5008)
        self.assertEqual(rows[-1][0], '5007')

    def test_export_keeps_membership_and_empty_card_distinct(self):
        with patch.object(api, '_common_context', return_value=(list(self.entries), self.entries, self.names, {})):
            response = api.api_export_common(request(groups='s1,s2,t', source_groups='s1,s2', selected='3', format='csv'))
        rows = list(csv.reader(io.StringIO(response.body.decode('utf-8-sig'))))
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1][:6], ['3', '昵称3', '1', '李四', '师生一', '否'])
        self.assertEqual(rows[1][-4:], ['未加入', '', '', ''])

    def test_comparison_uses_same_card_length_as_sync(self):
        name = '😀' * 41
        entries = {'s': entry('s', [member('1', name)]), 't': entry('t', [member('1', name[:40])])}
        result = members.common_members(entries, {}, source_groups=['s'], status='different')
        self.assertEqual(result['total'], 0)


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.entries = {
            's': entry('s', [member('1', '张三'), member('2', ''), member('3', '李四'),
                             member('4', '管理员'), member('5', '群主'), member('6', '同名'),
                             member('7', '😀' * 41)]),
            't': entry('t', [member('99', '管理号', 'admin'), member('1', '旧群昵称'), member('2', ''),
                             member('4', '', 'admin'), member('5', '', 'owner'), member('6', '同名'), member('7', '')]),
            't2': entry('t2', [member('99', '管理号', 'owner'), member('1', '')]),
        }
        self.groups = {gid: {'group_id': gid, 'group_name': gid, 'my_role': 'admin'} for gid in self.entries}
        self.rows = members.common_members(self.entries, {}, source_groups=['s'], size=None)['items']

    def test_preview_reuses_permissions_and_reports_skip_reasons(self):
        plan = cards.preview_sync(self.rows, self.entries, self.groups, ['t'], '99')
        self.assertEqual({item['qq'] for item in plan['items']}, {'1', '7'})
        self.assertEqual(plan['stats']['people'], 2)
        reasons = plan['stats']['reasons']
        for reason in ['没有非空参考群昵称', '未加入目标群', '管理员无法修改同级管理员', '群主群昵称不可修改', '群昵称一致，无需修改']:
            self.assertIn(reason, reasons)
        long = next(item for item in plan['items'] if item['qq'] == '7')
        self.assertEqual(long['new_card'], '😀' * 40)
        self.assertTrue(long['clamped'])
        self.assertEqual(long['source_group_id'], 's')

    def test_only_empty_and_multi_group_people_vs_operations(self):
        plan = cards.preview_sync(self.rows, self.entries, self.groups, ['t', 't2'], '99', only_empty=True)
        self.assertNotIn(('t', '1'), {(item['group_id'], item['qq']) for item in plan['items']})
        self.assertIn(('t2', '1'), {(item['group_id'], item['qq']) for item in plan['items']})
        plan = cards.preview_sync(self.rows, self.entries, self.groups, ['t', 't2'], '99')
        self.assertEqual(plan['stats']['change'], 3)
        self.assertEqual(plan['stats']['people'], 2)

    def test_reviewed_names_are_frozen_and_new_targets_are_not_added(self):
        reviewed = [{'group_id': 't', 'qq': '1', 'new_card': '用户预演过的名字', 'source_group_id': 's'}]
        plan = cards.preview_sync([], self.entries, self.groups, ['t', 't2'], '99', reviewed=reviewed)
        self.assertEqual(len(plan['items']), 1)
        self.assertEqual(plan['items'][0]['new_card'], '用户预演过的名字')
        self.assertEqual(plan['items'][0]['group_id'], 't')
        # 权限或成员状态变化后，执行前重新检查并跳过。
        self.entries['t']['members'] = [member('99', '', 'member'), member('1', '')]
        plan = cards.preview_sync([], self.entries, self.groups, ['t'], '99', reviewed=reviewed)
        self.assertFalse(plan['items'])
        self.assertIn('自己在群内没有管理权限', plan['stats']['reasons'])
        self.entries['t']['members'] = []
        plan = cards.preview_sync([], self.entries, self.groups, ['t'], '99', reviewed=reviewed)
        self.assertIn('未加入目标群', plan['stats']['reasons'])

    def test_truncated_name_is_identical_when_reviewed_again(self):
        rows = [{'qq': '1', 'reference_card': '张' * 39 + ' 后缀', 'source_group_id': 's'}]
        preview = cards.preview_sync(rows, self.entries, self.groups, ['t'], '99')
        execute = cards.preview_sync([], self.entries, self.groups, ['t'], '99', reviewed=preview['items'])
        self.assertEqual(preview['items'][0]['new_card'], '张' * 39)
        self.assertEqual(execute['items'][0]['new_card'], preview['items'][0]['new_card'])

    def test_execute_saves_separate_snapshots_and_one_job(self):
        reviewed = [{'group_id': gid, 'qq': '1', 'new_card': '张三', 'source_group_id': 's'} for gid in ['t', 't2']]
        submit = Mock(return_value={'id': 'job'})
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(store, 'SNAPSHOT_DIR', Path(tmp) / 'snapshots'), \
                patch.object(store, 'LOG_DIR', Path(tmp) / 'logs'), \
                patch.object(store, 'CACHE_DIR', Path(tmp) / 'cache'), \
                patch.object(api, '_config', return_value={'batch': {'interval': 2}}), \
                patch.object(api, '_cross_context', return_value=(self.entries, self.groups, {'login': {'user_id': '99'}}, object())), \
                patch.object(jobs.MANAGER, 'submit', submit):
            result = api.api_cards_sync_execute(request(body={'source_group_ids': ['s'], 'target_group_ids': ['t', 't2'],
                                                              'items': reviewed, 'mode': 'full'}))
            self.assertEqual(result['planned'], 2)
            self.assertEqual(len(result['snapshots']), 2)
            tasks = submit.call_args.args[2]
            self.assertEqual([task['params']['group_id'] for task in tasks], ['t', 't2'])
            self.assertTrue(tasks[0]['label'].startswith('t · '))
            snapshots = [store.load_snapshot(snap['id']) for snap in result['snapshots']]
            self.assertEqual([snap['members'][0]['card'] for snap in snapshots], ['旧群昵称', ''])
            for snap in snapshots:
                rollback = cards.build_rollback_tasks(snap, snap['group_id'])
                self.assertEqual(rollback[0]['params']['group_id'], snap['group_id'])
                self.assertEqual(rollback[0]['params']['card'], snap['members'][0]['card'])
            self.assertEqual(len(submit.call_args.kwargs['meta']['snapshot_ids']), 2)

    def test_trial_and_full_confirmation_do_not_expand_review(self):
        reviewed = [{'group_id': 't', 'qq': str(index), 'new_card': '姓名', 'source_group_id': 's'} for index in range(1, 102)]
        body = {'source_group_ids': ['s'], 'target_group_ids': ['t'], 'items': reviewed, 'mode': 'full'}
        with self.assertRaisesRegex(AppError, '101'):
            api.api_cards_sync_execute(request(body=body))
        body['mode'] = 'trial'
        with patch.object(api, '_config', return_value={'batch': {'trial_size': 10}}), \
                patch.object(api, '_cross_context', return_value=(self.entries, self.groups, {'login': {'user_id': '99'}}, object())), \
                patch.object(cards, 'preview_sync', side_effect=AppError('stop')) as preview:
            with self.assertRaisesRegex(AppError, 'stop'):
                api.api_cards_sync_execute(request(body=body))
        self.assertEqual(len(preview.call_args.kwargs['reviewed']), 10)

    def test_source_targets_cannot_overlap(self):
        with self.assertRaisesRegex(AppError, '基准群只作为来源'):
            api.api_cards_sync_preview(request(body={'source_group_ids': ['s'], 'target_group_ids': ['s']}))

    def test_preview_respects_selected_scope_and_forces_fresh_data(self):
        with patch.object(api, '_config', return_value={'batch': {'interval': 2}}), \
                patch.object(api, '_cross_context', return_value=(self.entries, self.groups, {'login': {'user_id': '99'}}, object())) as context:
            plan = api.api_cards_sync_preview(request(body={'source_group_ids': ['s'], 'target_group_ids': ['t', 't2'],
                                                           'filters': {'selected': '1'}, 'only_empty': True}))
        self.assertEqual([(item['group_id'], item['qq']) for item in plan['items']], [('t2', '1')])
        self.assertTrue(context.call_args.kwargs['force'])

    def test_group_read_failure_is_not_reported_as_absence(self):
        group_list = [{'group_id': 's', 'group_name': '师生群'}, {'group_id': 't', 'group_name': '课程群'}]
        with patch.object(api, '_session', return_value={'login': {'user_id': '99'}}), \
                patch.object(api, '_active_client', return_value=(object(), {})), \
                patch.object(api.groups, 'list_groups', return_value=group_list), \
                patch.object(members, 'fetch_many', return_value=({'s': self.entries['s']}, {'t': RuntimeError('offline')})):
            with self.assertRaises(AppError) as result:
                api.api_members_common(request(groups='s,t'))
        self.assertIn('课程群', result.exception.hint)

    def test_cache_expired_after_card_job_including_failure(self):
        manager = jobs.JobManager()
        client = Mock()
        with patch.object(members, 'expire') as expire, patch.object(store, 'log_event'), \
                patch.object(jobs.random, 'uniform', return_value=0):
            client.call.side_effect = RuntimeError('failed')
            job = manager.submit(client, 'card', [{'action': 'set_group_card', 'params': {'group_id': 't'}}],
                                 title='test', interval=0, retries=0)
            manager._queue.join()
            self.assertEqual(manager.get(job['id'])['status'], 'failed')
            expire.assert_called_once_with(client, 't')


if __name__ == '__main__':
    unittest.main()
