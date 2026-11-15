import copy
import csv
import io
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app import api, config
from app.core import fields, filters, store
from app.core.errors import AppError, UnsupportedAction
from app.server import Request
from app.services import collection, groups, jobs, members, presets, query, rename


def person(qq, card='', role='member', **extra):
    return members.normalize({'user_id': qq, 'nickname': '昵称'+str(qq), 'card': card,
                              'role': role, 'level': '12', 'join_time': 1700000000,
                              'last_sent_time': 1700000000, 'title': '', **extra})


def group(gid, name):
    return {'group_id': gid, 'group_name': name, 'group_remark': name, 'member_count': 3,
            'max_member_count': 500, 'my_role': 'owner', 'manageable': True,
            'raw': {'get_group_list': {'group_id': gid, 'group_name': name, 'extra': {'flag': True}}}}


class RuleTests(unittest.TestCase):
    def test_regex_flags_and_display_values_are_shared(self):
        record = {'member': {'card': 'Alice\n同学', 'role': 'admin', 'join_time': 1700000000}}
        self.assertTrue(filters.Predicate({'field': 'member.card', 'op': 'regex', 'value': '^alice.*同学$', 'flags': 'is'})(record))
        self.assertTrue(filters.Predicate({'field': 'member.role', 'op': 'regex', 'value': '^管理员$'})(record))
        self.assertTrue(filters.Predicate({'field': 'member.join_time', 'op': 'regex', 'value': '^2023-11-15'})(record))

    def test_typed_numbers_dates_booleans_and_relative_days(self):
        record = {'member': {'level': 12, 'is_robot': False, 'join_time': 1700000000, 'last_sent_time': time.time()-10*86400}}
        rule = {'op': 'and', 'rules': [
            {'field': 'member.level', 'op': 'gte', 'value': '10'},
            {'field': 'member.is_robot', 'op': 'eq', 'value': 'false'},
            {'field': 'member.join_time', 'op': 'between', 'value': '2023-01-01,2023-12-31T23:59:59'},
            {'field': 'member.last_sent_time', 'op': 'within_days', 'value': 30},
            {'field': 'member.last_sent_time', 'op': 'older_days', 'value': 5},
        ]}
        self.assertTrue(filters.Predicate(rule)(record))
        self.assertFalse(filters.Predicate({'field': 'member.level', 'op': 'gt', 'value': 20})(record))
        self.assertTrue(filters.Predicate({'field': 'member.level', 'op': 'in', 'value': '10, 12, 20'})(record))
        self.assertTrue(filters.Predicate({'field': 'member.is_robot', 'op': 'in', 'value': 'false'})(record))
        self.assertTrue(filters.Predicate({'field': 'member.join_time', 'op': 'in', 'value': ['2023-11-15T06:13:20']})(record))

    def test_missing_is_not_empty_or_negative_match(self):
        self.assertTrue(filters.Predicate({'field': 'member.card', 'op': 'missing'})({}))
        self.assertFalse(filters.Predicate({'field': 'member.card', 'op': 'empty'})({}))
        self.assertFalse(filters.Predicate({'field': 'member.card', 'op': 'not_regex', 'value': 'x'})({}))
        self.assertTrue(filters.Predicate({'field': 'member.card', 'op': 'empty'})({'member': {'card': ''}}))
        self.assertFalse(filters.Predicate({'field': 'member.level', 'op': 'empty'})({'member': {'level': 0}}))

    def test_relation_conditions_must_match_the_same_record(self):
        record = {'memberships': [{'group': {'group_id': '10'}, 'member': {'role': 'admin'}},
                                  {'group': {'group_id': '20'}, 'member': {'role': 'member'}}]}
        where = {'op': 'and', 'rules': [{'field': 'group.group_id', 'op': 'eq', 'value': '20'},
                                      {'field': 'member.role', 'op': 'eq', 'value': 'admin'}]}
        self.assertFalse(filters.Predicate({'relation': 'memberships', 'quantifier': 'any', 'where': where})(record))
        self.assertTrue(filters.Predicate({'relation': 'memberships', 'quantifier': 'count', 'compare': 'eq', 'value': 1,
                                          'where': {'field': 'member.role', 'op': 'eq', 'value': 'admin'}})(record))
        self.assertFalse(filters.Predicate({'relation': 'memberships', 'quantifier': 'all', 'where': where})({'memberships': []}))
        self.assertTrue(filters.Predicate({'relation': 'memberships', 'quantifier': 'none', 'where': where})({'memberships': []}))

    def test_nested_and_or_not_and_invalid_rules(self):
        rule = {'op': 'not', 'rules': [{'op': 'or', 'rules': [{'field': 'member.level', 'op': 'lt', 'value': 5},
                                                           {'field': 'member.card', 'op': 'empty'}]}]}
        self.assertTrue(filters.Predicate(rule)({'member': {'level': 12, 'card': '张三'}}))
        for bad in ([], {'field': 'member.card', 'op': 'regex', 'value': '['}, {'rules': [], 'op': 'invalid'}):
            with self.assertRaises(AppError):
                filters.Predicate(bad)


class DatasetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.patch_cache = patch.object(store, 'CACHE_DIR', Path(self.tmp.name))
        self.patch_cache.start()
        self.addCleanup(self.patch_cache.stop)
        self.group_list = [group('10', '【师生】26级'), group('11', '【师生】25级'), group('20', '【课程】实践课')]
        self.entries = {
            '10': {'group_id': '10', 'fetched_at': 1700000000, 'members': [person('1', '26级-张三-1班', 'admin', custom={'campus': '北校区'}), person('2', '李四')]},
            '11': {'group_id': '11', 'fetched_at': 1700000000, 'members': [person('1', '张三')]},
            '20': {'group_id': '20', 'fetched_at': 1700000000, 'members': [person('1', '旧昵称'), person('3', '', 'admin', last_sent_time=0)]},
        }
        self.client = SimpleNamespace(cache_namespace='test-query')
        self.mock_groups = patch.object(groups, 'list_groups', side_effect=lambda *args, **kwargs: copy.deepcopy(self.group_list))
        self.mock_members = patch.object(members, 'fetch_many', side_effect=lambda client, ids, force=False: ({gid: copy.deepcopy(self.entries[gid]) for gid in ids}, {}))
        self.mock_groups.start(); self.mock_members.start()
        self.addCleanup(self.mock_groups.stop); self.addCleanup(self.mock_members.stop)

    def spec(self, **extra):
        return {'entity': 'memberships', 'scope': {'group_ids': ['10', '11', '20'], 'source_group_ids': ['10', '11']}, **extra}

    def data(self, spec=None):
        return query.prepare(self.client, '99', spec or self.spec())

    def test_raw_fields_survive_normalization_and_are_discoverable(self):
        dataset = self.data()
        row = dataset['records'][0]
        self.assertEqual(row['member']['raw']['get_group_member_list']['custom'], {'campus': '北校区'})
        self.assertEqual(row['member']['level'], 12)
        keys = {field['id'] for field in dataset['fields']}
        self.assertIn('member.raw.get_group_member_list.custom.campus', keys)
        self.assertIn('group.raw.get_group_list.extra.flag', keys)
        rule = {'field': 'member.raw.get_group_member_list.custom.campus', 'op': 'regex', 'value': '北'}
        self.assertEqual(query.execute(dataset, self.spec(filter=rule))['total'], 1)

    def test_matrix_keeps_unmatched_memberships_present(self):
        spec = self.spec(entity='people', filter={'field': 'member.role', 'op': 'eq', 'value': 'admin'})
        result = query.execute(self.data(spec), spec)
        self.assertEqual(result['total'], 2)
        first = next(row for row in result['items'] if row['qq'] == '1')
        by_group = {membership['group_id']: membership for membership in first['memberships']}
        self.assertIn('20', by_group)
        self.assertFalse(by_group['20']['matched'])
        self.assertEqual(by_group['20']['display']['member.card'], '旧昵称')
        self.assertTrue(first['person']['source_conflict'])

    def test_reference_groups_outside_visible_scope_do_not_change_group_count(self):
        spec = {'entity': 'people', 'scope': {'group_ids': ['20'], 'source_group_ids': ['10', '11']}}
        dataset = self.data(spec)
        result = query.execute(dataset, spec)
        row = next(row for row in result['items'] if row['qq'] == '1')
        self.assertEqual(row['person']['reference_card'], '26级-张三-1班')
        self.assertEqual(row['person']['group_count'], 1)
        self.assertEqual([membership['group_id'] for membership in row['memberships']], ['20'])
        self.assertEqual([group['group_id'] for group in result['groups']], ['20'])

    def test_member_preset_is_available_in_group_directory(self):
        spec = self.spec(entity='groups', filter={'field': 'member.role', 'op': 'eq', 'value': 'admin'})
        result = query.execute(self.data(spec), spec)
        self.assertEqual({row['id'] for row in result['items']}, {'10', '20'})
        spec['filter'] = {'relation': 'memberships', 'quantifier': 'any', 'where': {'field': 'group.group_id', 'op': 'eq', 'value': '11'}}
        result = query.execute(self.data(spec), spec)
        self.assertEqual({row['id'] for row in result['items']}, {'10', '11', '20'})

    def test_query_export_uses_identical_filters_and_selected_ids(self):
        spec = self.spec(filter={'field': 'member.card', 'op': 'empty'}, fields=['member.qq', 'member.card'])
        dataset = self.data(spec)
        with patch.object(api, '_query_data', return_value=(dataset, None)):
            response = api.api_query_export(Request('POST', '/', {}, spec, {}))
        rows = list(csv.reader(io.StringIO(response.body.decode('utf-8-sig'))))
        self.assertEqual(rows, [['QQ号', '群昵称'], ['3', '']])
        spec['selected'] = ['20:1']
        self.assertEqual(query.execute(dataset, spec)['total'], 0)

    def test_regex_grouping_and_numeric_sort(self):
        spec = self.spec(group_by={'field': 'group.display_name', 'pattern': '^【(.+?)】'})
        result = query.execute(self.data(spec), spec)
        self.assertEqual(result['buckets'], {'师生': 3, '课程': 2})
        self.assertEqual({row['bucket'] for row in result['items']}, {'师生', '课程'})
        self.entries['20']['members'][0] = person('1', '旧昵称', level='100')
        spec = self.spec(sort={'field': 'member.level', 'desc': True})
        result = query.execute(self.data(spec), spec)
        self.assertEqual(result['items'][0]['group_id'], '20')
        spec['group_by'] = {'field': 'group.display_name', 'pattern': '^(不存在)?'}
        self.assertEqual(query.execute(self.data(spec), spec)['buckets'], {'未分组': 5})

    def test_fresh_list_values_win_over_older_details(self):
        detail = {'members': {'1': {'get_group_member_info': {'status': 'ok', 'at': 1, 'data': {'card': '旧详情昵称', 'role': 'owner', 'age': 22}}}}}
        row = query.normalize_member(person('1', '新昵称', 'member'), detail, list_at=2)
        self.assertEqual(row['card'], '新昵称')
        self.assertEqual(row['role'], 'member')
        self.assertEqual(row['age'], 22)

    def test_missing_filter_field_collects_then_evaluates(self):
        self.client.call = lambda action, **params: {'user_id': params['user_id'], 'age': int(params['user_id'])+20}
        spec = {'entity': 'memberships', 'scope': {'group_ids': ['20']}, 'filter': {'field': 'member.age', 'op': 'gte', 'value': 22}}
        dataset = self.data(spec)
        captured = []
        def submit(client, kind, work, **kwargs):
            captured.extend(work)
            return {'id': 'read-job'}
        with patch.object(jobs.MANAGER, 'submit', side_effect=submit):
            pending = query.pending_collection(self.client, dataset, spec)
        self.assertEqual(pending['id'], 'read-job')
        self.assertEqual(len(captured), 2)
        self.assertEqual({task['action'] for task in captured}, {'get_group_member_info'})
        for task in captured:
            task['run']()
        dataset = self.data(spec)
        self.assertIsNone(query.pending_collection(self.client, dataset, spec))
        result = query.execute(dataset, spec)
        self.assertEqual([row['qq'] for row in result['items']], ['3'])

    def test_failed_collection_cannot_look_like_a_negative_match(self):
        self.client.call = lambda *args, **kwargs: (_ for _ in ()).throw(AppError('暂时读取失败'))
        for qq in ('1', '3'):
            with self.assertRaises(AppError):
                collection.fetch(self.client, '20', 'get_group_member_info', qq)
        spec = {'entity': 'memberships', 'scope': {'group_ids': ['20']}, 'filter': {'field': 'member.age', 'op': 'ne', 'value': 20}}
        dataset = self.data(spec)
        with self.assertRaisesRegex(AppError, '采集失败'):
            query.pending_collection(self.client, dataset, spec)
        work = collection.tasks(self.client, self.entries, ['20'], retry_failed=True)
        self.assertEqual(len(work), 2)

    def test_unsupported_and_missing_fields_are_distinct_in_display(self):
        self.client.call = lambda *args, **kwargs: (_ for _ in ()).throw(UnsupportedAction('不支持'))
        for qq in ('1', '3'):
            with self.assertRaises(UnsupportedAction):
                collection.fetch(self.client, '20', 'get_group_member_info', qq)
        spec = {'entity': 'memberships', 'scope': {'group_ids': ['20']}, 'fields': ['member.qq', 'member.age'],
                'filter': {'field': 'member.age', 'op': 'missing'}}
        dataset = self.data(spec)
        self.assertIsNone(query.pending_collection(self.client, dataset, spec))
        self.assertEqual(query.execute(dataset, spec)['items'][0]['display']['member.age'], '不支持')

    def test_new_query_and_export_do_not_truncate_at_5000(self):
        self.entries['20']['members'] = [person(str(index)) for index in range(1, 5008)]
        spec = {'entity': 'memberships', 'scope': {'group_ids': ['20']}, 'fields': ['member.qq'], 'page': 101}
        dataset = self.data(spec)
        result = query.execute(dataset, spec)
        self.assertEqual(result['total'], 5007)
        self.assertEqual(len(result['items']), 7)
        self.assertEqual(len(query.execute(dataset, spec, paginate=False)['items']), 5007)

    def test_regex_rename_uses_the_shared_query_scope(self):
        spec = {'entity': 'memberships', 'scope': {'group_ids': ['20'], 'source_group_ids': ['10']},
                'selected': ['20:1'], 'filter': {'field': 'member.role', 'op': 'eq', 'value': 'member'}}
        dataset = self.data(spec)
        plan = rename.preview(dataset, {'query': spec, 'options': {'method': 'sync', 'template': '{result}',
            'regex': {'mode': 'extract', 'pattern': r'^\d+级-(?P<name>.+?)-.*$', 'capture': 'name'}}}, '99')
        self.assertEqual(len(plan['items']), 1)
        self.assertEqual(plan['items'][0]['new_card'], '张三')
        self.assertEqual(plan['items'][0]['group_id'], '20')
        self.assertEqual(plan['items'][0]['source_group_id'], '10')

    def test_collection_retains_each_interface_and_previous_success_on_failure(self):
        self.client.call = lambda *args, **kwargs: {'unknown': {'nested': 123}}
        collection.fetch(self.client, '20', 'get_group_info')
        collected_at = collection.load(self.client, '20')['group']['get_group_info']['at']
        self.client.call = lambda *args, **kwargs: (_ for _ in ()).throw(AppError('失败'))
        for _ in range(2):
            with self.assertRaises(AppError):
                collection.fetch(self.client, '20', 'get_group_info')
        result = collection.load(self.client, '20')['group']['get_group_info']
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['previous_data'], {'unknown': {'nested': 123}})
        self.assertEqual(result['previous_at'], collected_at)


class RenameAndPresetTests(unittest.TestCase):
    def test_directory_presets_use_my_role_and_keep_custom_rules(self):
        custom = {'id': 'custom-role', 'name': '自定义成员规则', 'rule': {'field': 'member.role', 'op': 'eq', 'value': 'owner'}, 'builtin': False}
        data = presets.catalog({'filter_presets': [custom]})
        group_presets = {item['id']: item for item in data['group_presets']}
        self.assertEqual(group_presets['builtin-owner']['rule'], {'field': 'group.my_role', 'op': 'eq', 'value': 'owner'})
        self.assertEqual(group_presets['builtin-admin']['name'], '我是管理员的群')
        self.assertEqual(group_presets['custom-role'], custom)
        self.assertNotIn('builtin-empty-card', group_presets)
        self.assertNotIn('builtin-single', group_presets)
        member_presets = {item['id']: item for item in data['presets']}
        self.assertEqual(member_presets['builtin-owner']['rule']['field'], 'member.role')
        self.assertIn('builtin-single', member_presets)

    def test_tagged_group_preset_checks_name_and_remark_prefixes(self):
        rule = next(item['rule'] for item in presets.listing({}, 'groups') if item['id'] == 'builtin-tagged')
        predicate = filters.Predicate(rule)
        for name in ('【活动】话剧《南望永怀》观众', '【团员】26上 新发展'):
            self.assertTrue(predicate({'group': {'group_name': name, 'group_remark': ''}}))
            self.assertTrue(predicate({'group': {'group_name': '普通群名称', 'group_remark': name}}))
        for name in ('普通群', '活动【观众】', '【】空标签', '【未闭合', '【嵌套【标签】'):
            self.assertFalse(predicate({'group': {'group_name': name, 'group_remark': ''}}))

    def test_regex_replacement_extraction_and_no_match(self):
        text, reason = rename.transformed('26级-张三', {'mode': 'replace', 'pattern': r'^\d+级-(?P<name>.*)$', 'replacement': r'\g<name>'})
        self.assertEqual((text, reason), ('张三', ''))
        self.assertEqual(rename.transformed('张三', {'mode': 'extract', 'pattern': r'^\d+'})[1], '正则未匹配')
        with self.assertRaises(AppError):
            rename.transformed('张三', {'mode': 'extract', 'pattern': '(张)', 'capture': '2'})
        with self.assertRaises(AppError):
            rename.transformed('张三', {'mode': 'replace', 'pattern': '[', 'replacement': ''})

    def test_csv_import_supports_header_bom_and_quoting(self):
        result = api.api_rename_import(Request('POST', '/', {}, {'text': '\ufeffQQ号,群昵称\n10001,"张三,技术组"\n10002,李四'}, {}))
        self.assertEqual(result['mapping'], {'10001': '张三,技术组', '10002': '李四'})
        with self.assertRaises(AppError):
            api.api_rename_import(Request('POST', '/', {}, {'text': 'abc,姓名'}, {}))

    def test_presets_crud_is_persistent_and_builtin_can_only_be_copied(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(config, 'CONFIG_PATH', Path(tmp)/'config.json'):
            rule = {'field': 'member.card', 'op': 'regex', 'value': '^张'}
            result = api.api_save_preset(Request('POST', '/', {}, {'name': '张姓', 'rule': rule}, {}))
            key = result['preset']['id']
            self.assertIn(key, {item['id'] for item in api.api_presets(Request('GET', '/', {}, {}, {}))['presets']})
            api.api_save_preset(Request('POST', '/', {}, {'name': '张姓成员', 'id': key, 'rule': rule}, {}))
            self.assertEqual(config.load()['filter_presets'][0]['name'], '张姓成员')
            api.api_delete_preset(Request('DELETE', '/', {}, {}, {}), key)
            self.assertEqual(config.load()['filter_presets'], [])
            with self.assertRaises(AppError):
                presets.delete({}, 'builtin-admin')
            with self.assertRaises(AppError):
                presets.save({}, {'name': '无效', 'rule': {'field': 'member.card', 'op': 'regex', 'value': '['}})


class CollectionJobTests(unittest.TestCase):
    def test_collection_is_bounded_and_can_be_canceled(self):
        manager = jobs.JobManager()
        started = threading.Event()
        release = threading.Event()
        active = 0
        maximum = 0
        lock = threading.Lock()
        def run():
            nonlocal active, maximum
            with lock:
                active += 1; maximum = max(maximum, active)
                if active == 4:
                    started.set()
            release.wait(3)
            with lock:
                active -= 1
        tasks = [{'action': 'read', 'params': {}, 'run': run, 'target': str(index), 'label': 'read'} for index in range(12)]
        with patch.object(store, 'log_event'):
            job = manager.submit(object(), 'collect', tasks, title='补全', interval=0)
            self.assertTrue(started.wait(2))
            manager.cancel(job['id']); release.set(); manager._queue.join()
        self.assertEqual(maximum, 4)
        self.assertEqual(manager.get(job['id'])['status'], 'canceled')
        self.assertLessEqual(manager.get(job['id'])['cursor'], 4)

    def test_group_memory_and_disk_cache_are_isolated_and_keep_raw_fields(self):
        class Client:
            def __init__(self, namespace):
                self.cache_namespace = namespace
                self.calls = 0
            def call(self, action, **params):
                self.calls += 1
                return [{'group_id': 1, 'group_name': self.cache_namespace, 'future_key': 'preserved'}] if action == 'get_group_list' else {'role': 'owner'}
        a, b = Client('a'), Client('b')
        with tempfile.TemporaryDirectory() as tmp, patch.object(store, 'CACHE_DIR', Path(tmp)):
            groups.invalidate(); groups._META.clear()
            try:
                self.assertEqual(groups.list_groups(a, '99')[0]['group_name'], 'a')
                self.assertEqual(groups.list_groups(b, '99')[0]['group_name'], 'b')
                groups.invalidate()
                self.assertEqual(groups.list_groups(a, '99')[0]['raw']['get_group_list']['future_key'], 'preserved')
                self.assertEqual(groups.list_groups(b, '99')[0]['group_name'], 'b')
                self.assertLessEqual(a.calls+b.calls, 4)
            finally:
                groups.invalidate(); groups._META.clear()


if __name__ == '__main__':
    unittest.main()
