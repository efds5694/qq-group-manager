import copy
import time
import unittest
from unittest.mock import patch

from app import api, config
from app.core.errors import AppError, UnsupportedAction
from app.onebot.adapters import get_adapter, declared_capabilities
from app.server import Request
from app.services import groupsettings as settings


class Client:
    cache_namespace = 'settings-test-account'

    def __init__(self):
        self.calls = []
        self.role = 'owner'
        self.name = '测试群'
        self.detail = {}
        self.roster = [
            {'user_id': '99', 'role': 'owner', 'nickname': '群主'},
            {'user_id': '11', 'role': 'admin', 'nickname': '甲'},
            {'user_id': '12', 'role': 'admin', 'nickname': '乙'},
            {'user_id': '13', 'role': 'member', 'nickname': '丙'},
        ]
        self.permissions = {'receive_verify': True, 'recall_member_message': True,
                            'kick_member': True, 'kick_member_per_day': 0}
        self.fail = {}

    def call(self, action, **params):
        self.calls.append((action, params))
        if action in self.fail:
            raise self.fail[action]
        if action == 'get_group_info':
            return {'group_name': self.name}
        if action == 'get_group_member_info':
            return {'role': self.role}
        if action == 'get_group_detail_info':
            return copy.deepcopy(self.detail)
        if action == 'get_group_member_list':
            return copy.deepcopy(self.roster)
        if action == 'get_group_admin_permissions':
            return copy.deepcopy(self.permissions)
        raise AssertionError(f'预演不应调用写接口：{action}')


GROUPS = [{'group_id': '100', 'group_name': '测试群', 'my_role': 'owner'}]


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.client = Client()

    def diff(self, template, adapter='napcat', groups=None):
        adapter = get_adapter(adapter)
        return settings.build_diff(self.client, groups or GROUPS, template,
                                   declared_capabilities(adapter), adapter, '99')

    def tasks(self, template, **kwargs):
        return settings.build_tasks(self.diff(template, **kwargs)['groups'])

    def test_all_five_join_modes_use_real_napcat_parameters(self):
        for mode, number in [('open', 1), ('approve', 2), ('closed', 3), ('question', 4), ('question_approve', 5)]:
            with self.subTest(mode=mode):
                tasks = self.tasks({'add_option': {'mode': mode, 'question': '班级姓名', 'answer': '正确答案'}})
                expected = {'group_id': '100', 'add_type': number}
                if number in (4, 5):
                    expected['group_question'] = '班级姓名'
                if number == 4:
                    expected['group_answer'] = '正确答案'
                self.assertEqual(tasks[0]['action'], 'set_group_add_option')
                self.assertEqual(tasks[0]['params'], expected)

    def test_question_validation_and_inactive_values(self):
        for value in [{'mode': 'question'}, {'mode': 'question', 'question': '问题'}, {'mode': 'question_approve'}]:
            with self.subTest(value=value), self.assertRaises(AppError):
                settings.normalize_template({'add_option': value})
        normal = settings.normalize_template({'add_option': {'mode': 'approve', 'question': '旧问题', 'answer': '旧答案'}})
        self.assertEqual(normal['add_option'], {'mode': 'approve', 'question': '', 'answer': ''})

    def test_question_and_answer_changes_are_included_even_if_mode_unchanged(self):
        self.client.detail = {'groupOption': 4, 'groupQuestion': '问题', 'groupAnswer': '旧答案'}
        template = {'add_option': {'mode': 'question', 'question': '问题', 'answer': '新答案'}}
        self.assertEqual(len(self.tasks(template)), 1)
        self.client.detail['groupAnswer'] = '新答案'
        self.assertEqual(self.tasks(template), [])

    def test_invitation_policy_supports_all_values_and_unchanged_skip(self):
        for value in settings.INVITE_POLICIES:
            with self.subTest(value=value):
                self.client.detail = {}
                task = self.tasks({'invite_policy': value})[0]
                self.assertEqual(task['action'], 'set_group_member_invite_policy')
                self.assertEqual(task['params'], {'group_id': '100', 'policy': value})
                self.client.detail = {'member_invite_policy': value}
                self.assertEqual(self.tasks({'invite_policy': value}), [])
        self.client.detail = {'privilegeFlag': 0x04000000}
        self.assertEqual(self.tasks({'invite_policy': 'disabled'}), [])

    def test_add_and_remove_deduplicate_targets_and_skip_owner_absent_and_unchanged(self):
        template = {'admin': {'mode': 'add', 'user_ids': '13,13，11\n99 88'}}
        diff = self.diff(template)
        tasks = settings.build_tasks(diff['groups'])
        self.assertEqual([t['params'] for t in tasks], [{'group_id': '100', 'user_id': '13', 'enable': True}])
        notes = [f['note'] for f in diff['groups'][0]['fields']]
        self.assertIn('不能更改群主身份', notes)
        self.assertIn('该 QQ 未加入本群', notes)
        tasks = self.tasks({'admin': {'mode': 'remove', 'user_ids': ['11', '13']}})
        self.assertEqual([t['params'] for t in tasks], [{'group_id': '100', 'user_id': '11', 'enable': False}])

    def test_member_admin_changes_require_fresh_owner_role_but_regular_settings_allow_admin(self):
        self.client.role = 'admin'
        diff = self.diff({'group_name': '新群名', 'admin': {'mode': 'add', 'user_ids': ['13']}})
        self.assertEqual([t['action'] for t in settings.build_tasks(diff['groups'])], ['set_group_name'])
        self.assertEqual(diff['skipped'], 1)
        self.client.role = 'member'
        self.assertEqual(self.tasks({'group_name': '新群名'}), [])
        self.client.fail['get_group_member_info'] = AppError('身份读取失败')
        self.assertEqual(self.tasks({'whole_ban': 'on'}), [])

    def test_multiple_groups_report_permissions_independently(self):
        original = self.client.call
        def call(action, **params):
            if action == 'get_group_member_info' and params['group_id'] == '200':
                return {'role': 'member'}
            return original(action, **params)
        self.client.call = call
        diff = self.diff({'admin': {'mode': 'add', 'user_ids': ['13']}}, groups=GROUPS + [{'group_id': '200'}])
        self.assertEqual(diff['total_changes'], 1)
        self.assertEqual([g['actionable'] for g in diff['groups']], [1, 0])

    def test_permissions_apply_to_existing_admins_and_preserve_unspecified_fields(self):
        template = {'admin': {'mode': 'permissions', 'target': 'all', 'permissions': {'recall_member_message': 'off'}}}
        tasks = self.tasks(template, adapter='snowluma')
        self.assertEqual([t['params'] for t in tasks], [
            {'group_id': '100', 'user_id': qq, 'recall_member_message': False} for qq in ('11', '12')])
        self.assertTrue(all(t['action'] == 'set_group_admin_permissions' for t in tasks))
        self.client.roster.reverse()
        self.assertEqual(self.tasks(template, adapter='snowluma'), tasks)

    def test_kick_permission_and_daily_limit_are_one_request_and_receive_is_separate(self):
        template = {'admin': {'mode': 'permissions', 'user_ids': ['11'], 'permissions': {
            'kick_member': 'on', 'kick_member_per_day': 20, 'receive_verify': 'off'}}}
        tasks = self.tasks(template, adapter='snowluma')
        self.assertEqual(tasks[0]['params'], {'group_id': '100', 'user_id': '11', 'kick_member': True, 'kick_member_per_day': 20})
        self.assertEqual(tasks[1]['action'], 'set_group_admin_receive_verify')
        self.assertEqual(tasks[1]['params'], {'group_id': '100', 'user_id': '11', 'enable': False})
        template['admin']['permissions']['kick_member'] = 'off'
        tasks = self.tasks(template, adapter='snowluma')
        self.assertNotIn('kick_member_per_day', tasks[0]['params'])

    def test_owner_target_only_sets_verification_messages(self):
        template = {'admin': {'mode': 'permissions', 'target': 'owner', 'permissions': {
            'receive_verify': 'off', 'recall_member_message': 'off', 'kick_member': 'on'}}}
        tasks = self.tasks(template, adapter='snowluma')
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]['params'], {'group_id': '100', 'user_id': '99', 'enable': False})

    def test_napcat_unsupported_permissions_do_not_create_fake_tasks(self):
        diff = self.diff({'admin': {'mode': 'permissions', 'user_ids': ['11'], 'permissions': {'recall_member_message': 'off', 'receive_verify': 'off'}}})
        self.assertEqual(diff['total_changes'], 0)
        self.assertEqual(diff['skipped'], 2)
        self.assertFalse(any(action == 'get_group_admin_permissions' for action, _ in self.client.calls))

    def test_runtime_read_failure_skips_permission_writes_and_retains_other_settings(self):
        self.client.fail['get_group_admin_permissions'] = UnsupportedAction('版本不提供此接口')
        diff = self.diff({'whole_ban': 'on', 'admin': {'mode': 'permissions', 'user_ids': ['11'], 'permissions': {'receive_verify': 'off'}}}, adapter='snowluma')
        self.assertEqual([t['action'] for t in settings.build_tasks(diff['groups'])], ['set_group_whole_ban'])
        self.assertIn('版本不提供此接口', diff['groups'][0]['fields'][-1]['note'])
        self.client.fail['get_group_member_list'] = AppError('成员列表读取失败')
        self.assertEqual(self.tasks({'admin': {'mode': 'remove', 'user_ids': ['11']}}), [])

    def test_unchanged_permissions_and_ban_create_no_tasks(self):
        self.client.detail['group_all_shut'] = 0
        template = {'whole_ban': 'off', 'admin': {'mode': 'permissions', 'user_ids': ['11'], 'permissions': {
            'receive_verify': 'on', 'recall_member_message': 'on', 'kick_member': 'on', 'kick_member_per_day': 0}}}
        self.assertEqual(self.tasks(template, adapter='snowluma'), [])

    def test_validation_rejects_invalid_modes_limits_and_targets(self):
        values = [{'whole_ban': 'wrong'}, {'invite_policy': 'wrong'}, {'add_option': {'mode': 'wrong'}},
                  {'admin': {'mode': 'add'}}, {'admin': {'mode': 'remove', 'user_ids': ['11', 'invalid']}},
                  {'admin': {'mode': 'permissions', 'target': 'all'}},
                  {'admin': {'mode': 'permissions', 'target': 'all', 'permissions': {'kick_member': 'on', 'kick_member_per_day': 7}}}]
        for value in values:
            with self.subTest(value=value), self.assertRaises(AppError):
                settings.normalize_template(value)
        normal = settings.normalize_template({'admin': {'mode': 'keep', 'user_ids': '未使用的草稿'}})
        self.assertEqual(normal['admin']['user_ids'], [])
        with self.assertRaises(AppError):
            self.diff({})

    def test_group_variables_and_notice_use_adapter_action_and_render_per_group(self):
        diff = self.diff({'group_name': '{group_name}-{group_id}', 'notice': '{group_name}：{group_id}'})
        self.assertEqual(diff['warnings'], [])
        tasks = settings.build_tasks(diff['groups'])
        self.assertEqual(tasks[0]['params']['group_name'], '测试群-100')
        self.assertEqual(tasks[1]['action'], '_send_group_notice')
        self.assertEqual(tasks[1]['params']['content'], '测试群：100')
        self.assertTrue(self.diff({'group_name': '{nickname}'})['warnings'])


class SettingsApiTests(unittest.TestCase):
    def setUp(self):
        self.client = Client()
        session = {'login': {'user_id': '99'}, 'adapter': 'napcat',
                   'capabilities': declared_capabilities(get_adapter('napcat'))}
        patches = [patch.object(api, '_session', return_value=session),
                   patch.object(api, '_active_client', return_value=(self.client, {})),
                   patch.object(api.groups, 'list_groups', return_value=GROUPS),
                   patch.object(api, '_config', return_value={'batch': {}}),
                   patch.object(api.store, 'save_snapshot', return_value={'id': 'snapshot'}),
                   patch.object(api.jobs.MANAGER, 'submit', return_value={'id': 'job'})]
        self.mocks = [p.start() for p in patches]
        for p in patches:
            self.addCleanup(p.stop)
        api._SETTINGS_PREVIEWS.clear()
        self.addCleanup(api._SETTINGS_PREVIEWS.clear)

    @staticmethod
    def request(body):
        return Request('POST', '/api/settings', {}, body, {})

    def preview(self, template=None):
        return api.api_settings_preview(self.request({'group_ids': ['100', '100'], 'template': template or {'group_name': '{group_name}-新'}}))

    def execute(self, preview, **extra):
        return api.api_settings_execute(self.request({'preview_id': preview['preview_id'], 'confirmed': True, **extra}))

    def test_preview_is_read_only_and_execution_uses_reviewed_values_once(self):
        preview = self.preview()
        self.assertEqual(len(preview['groups']), 1)
        self.mocks[-1].assert_not_called()
        result = api.api_settings_execute(self.request({'preview_id': preview['preview_id'],
                                                       'template': {'group_name': '未预演的值'}, 'group_ids': ['200']}))
        self.assertEqual(result['planned'], 1)
        task = self.mocks[-1].call_args.args[2][0]
        self.assertEqual(task['params'], {'group_id': '100', 'group_name': '测试群-新'})
        with self.assertRaises(AppError):
            self.execute(preview)
        self.mocks[-1].assert_called_once()

    def test_changed_group_name_or_role_requires_new_preview(self):
        preview = self.preview()
        self.client.name = '已被其他人修改'
        with self.assertRaisesRegex(AppError, '已变化'):
            self.execute(preview)
        self.client.name = '测试群'
        self.client.role = 'member'
        with self.assertRaisesRegex(AppError, '已变化'):
            self.execute(preview)
        self.mocks[-1].assert_not_called()

    def test_expiration_and_account_binding_are_enforced(self):
        preview = self.preview()
        self.client.cache_namespace = 'other-account'
        with self.assertRaises(AppError):
            self.execute(preview)
        self.client.cache_namespace = Client.cache_namespace
        api._SETTINGS_PREVIEWS[preview['preview_id']]['at'] = time.time() - 1801
        with self.assertRaises(AppError):
            self.execute(preview)
        self.mocks[-1].assert_not_called()

    def test_deleted_template_ids_do_not_overwrite_unrelated_templates(self):
        cfg = {'templates': [{'id': 'tpl-1', 'name': '保留模板'}]}
        with patch.object(config, 'save'):
            saved = config.save_template(cfg, {'name': '新模板'})
            self.assertNotEqual(saved['id'], 'tpl-1')
            config.save_template(cfg, {'id': saved['id'], 'name': '已更新'})
        self.assertEqual(len(cfg['templates']), 2)
        self.assertEqual(cfg['templates'][0]['name'], '保留模板')
