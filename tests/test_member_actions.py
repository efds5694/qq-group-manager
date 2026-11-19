import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import api
from app.core import store
from app.core.errors import AppError, NetworkError
from app.onebot.client import OneBotClient
from app.server import Request
from app.services import member_actions, members, results, roster_match, rosters


def member(qq, card="", role="member"):
    return {"qq": qq, "card": card, "nickname": f"成员 {qq}", "role": role}


class MatchTests(unittest.TestCase):
    def test_all_card_forms_and_full_width_separator(self):
        imported = roster_match.read({"text": (
            "| 姓名 | 班级 | 学号 | 手机号 | 身份证号 |\n"
            "| --- | --- | --- | --- | --- |\n"
            "| 测试甲 | 电气H2403 | 2415000017 | 17720000012 | 不应进入结果 |\n"
        )})
        for card in ("电气H2403测试甲", "电气h2403 测试甲", "电气Ｈ２４０３－测试甲",
                     "电气H2403测试甲17720000012", "2415000017电气H2403测试甲",
                     "2415000017", "17720000012"):
            with self.subTest(card=card):
                rows, _ = roster_match.match(imported, {"10": "来源群"}, {"10": {"10": member("10", card)}})
                self.assertEqual(rows[0]["suggested"], "10")
                self.assertNotIn("17720000012", str(rows))
                self.assertNotIn("不应进入结果", str(rows))

    def test_numeric_tokens_different_class_and_same_account_across_groups(self):
        imported = roster_match.read({"text": "姓名\t班级\t学号\n测试甲\t电气H2403\t2415000017"})
        rows, _ = roster_match.match(imported, {"10": "群一", "20": "群二"}, {
            "10": {"100": member("100", "电气H2403测试甲"),
                   "200": member("200", "124150000179"), "300": member("300", "电气2403测试甲")},
            "20": {"100": member("100", "2415000017")},
        })
        self.assertEqual(rows[0]["suggested"], "100")
        self.assertEqual([item["qq"] for item in rows[0]["candidates"]], ["100"])
        self.assertEqual({item["group_id"] for item in rows[0]["candidates"][0]["evidence"]}, {"10", "20"})

    def test_conflicting_fields_name_only_and_reused_qq_need_confirmation(self):
        imported = roster_match.read({"text": "姓名,班级,学号\n甲,电气2403,2415000017\n乙,,\n丙,,2415000018\n丁,,2415000018"})
        rows, accounts = roster_match.match(imported, {"10": "来源群"}, {"10": {
            "10": member("10", "电气2403甲"), "20": member("20", "2415000017"),
            "30": member("30", "乙"), "40": member("40", "2415000018"),
        }})
        self.assertEqual([row["status"] for row in rows], ["conflict", "review", "conflict", "conflict"])
        self.assertEqual(roster_match.confirm(rows, accounts, {"2": "10", "3": "30"}), ["10", "30"])
        with self.assertRaisesRegex(AppError, "分给了多人"):
            roster_match.confirm(rows, accounts, {"4": "40", "5": "40"})
        with self.assertRaisesRegex(AppError, "来源群"):
            roster_match.confirm(rows, accounts, {"2": "42"})


class SelectionActionTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        patcher = patch.object(store, "DATA_DIR", Path(temp.name))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.account = "99"
        self.groups = {
            "10": {"99": member("99", role="admin"), "100": member("100"), "200": member("200", role="admin"),
                   "300": member("300"), "400": member("400")},
            "20": {"99": member("99", role="member"), "200": member("200")},
        }
        self.calls = []

    def call(self, action, **params):
        self.calls.append((action, params))
        if action == "get_group_info":
            return {"group_name": "测试目标群"}
        if action == "get_group_share_link":
            return {"url": "https://qm.qq.com/q/mock"}
        if action == "get_login_info":
            return {"user_id": self.account}
        if action == "get_friend_list":
            return [{"user_id": 100}]
        if action == "send_private_msg":
            if params["user_id"] == 300:
                raise AppError("cannot send to user in group: no such temp session", retcode=100)
            if params["user_id"] == 400:
                raise NetworkError("请求超时")

    def listing(self, *_args, **_kwargs):
        return [{"group_id": group_id, "group_name": group_id} for group_id in self.groups]

    def fetch(self, _client, group_id, force=False):
        self.assertTrue(force)
        return {"fetched_at": 100, "members": list(self.groups[group_id].values())}

    def test_invite_skips_joined_and_separates_sent_refused_and_unknown(self):
        with patch.object(members, "fetch", side_effect=self.fetch), patch.object(member_actions.groups, "list_groups", side_effect=self.listing):
            plan = member_actions.preview(self, self.account, "snowluma", ["10"], ["100", "200", "300", "400"],
                                          {"operation": "invite", "group_id": "20"})
            self.assertEqual(plan["ready"], 3)
            self.assertEqual(plan["rows"][1]["reason"], "已在目标群")
            self.assertEqual([row.get("channel") for row in plan["rows"]], ["friend", None, "temporary", "temporary"])
            self.assertFalse(any(action == "send_private_msg" for action, _ in self.calls))
            roster_id = rosters.create_invitation("99", "目标", "20", ["10"], ["100", "200", "300", "400"],
                                                  self.fetch(self, "20", force=True), self.groups["20"])
            tasks = member_actions.tasks(self, "99", plan, roster_id)
            tasks[0]["run"]()
            with self.assertRaisesRegex(AppError, "未找到可用的群临时会话"):
                tasks[1]["run"]()
            with self.assertRaisesRegex(AppError, "结果未知"):
                tasks[2]["run"]()
            self.assertIn("已发送", tasks[0]["run"]())
            saved = rosters.load("99", roster_id)
            self.assertEqual([member["delivery"] for member in saved["members"]], ["sent", "already", "manual", "unknown"])
            self.assertEqual([member["present"] for member in saved["members"]], [False, True, False, False])
            self.assertEqual([params.get("group_id") for action, params in self.calls if action == "send_private_msg"],
                             [None, 10, 10])
            self.assertEqual(rosters.build(saved, {"status": "manual"})["total"], 2)

    def test_closed_target_blocks_sending_but_can_save_tracking_for_manual_handling(self):
        owner = ("test", self.account)
        request = lambda body: Request("POST", "", {}, body, {})
        original_call = self.call

        def call(action, **params):
            if action == "get_group_detail_info":
                return {"groupOption": 3}
            return original_call(action, **params)

        with patch.object(self, "call", side_effect=call), \
                patch.object(members, "fetch", side_effect=self.fetch), \
                patch.object(member_actions.groups, "list_groups", side_effect=self.listing), \
                patch.object(api, "_result_owner", return_value=owner), \
                patch.object(api, "_active_client", return_value=(self, {})), \
                patch.object(results, "STORE", results.ResultStore()), \
                patch.object(api.jobs.MANAGER, "submit") as submit:
            plan = member_actions.preview(self, self.account, "snowluma", ["10"], ["100", "200"],
                                          {"operation": "invite", "group_id": "20", "link": "https://qm.qq.com/q/mock"})
            self.assertEqual(plan["ready"], 0)
            self.assertIn("不允许任何人加群", plan["link_error"])
            entry = results.STORE.create(owner, {"entity": "member_action", "items": []}, plan)
            key = {"preview_id": entry["query_id"]}
            with self.assertRaisesRegex(AppError, "没有可执行"):
                api.api_member_action_execute(request(key))
            result = api.api_member_action_execute(request({**key, "track_only": True}))
            with self.assertRaisesRegex(AppError, "已失效"):
                api.api_member_action_execute(request({**key, "track_only": True}))
            submit.assert_not_called()
        self.assertNotIn("job", result)
        saved = rosters.load(self.account, result["tracking_id"])
        self.assertEqual([row["delivery"] for row in saved["members"]], ["manual", "already"])
        self.assertEqual([row["present"] for row in saved["members"]], [False, True])

    def test_generic_share_link_error_prompts_checking_settings_without_assuming_a_cause(self):
        original_call = self.call

        def call(action, **params):
            if action == "get_group_share_link":
                raise AppError("请求参数不合法", retcode=100)
            return original_call(action, **params)

        with patch.object(self, "call", side_effect=call), \
                patch.object(members, "fetch", side_effect=self.fetch), \
                patch.object(member_actions.groups, "list_groups", side_effect=self.listing):
            plan = member_actions.preview(self, self.account, "snowluma", ["10"], ["100"],
                                          {"operation": "invite", "group_id": "20"})
        self.assertEqual(plan["ready"], 0)
        self.assertIn("检查目标群的加群方式", plan["link_error"])
        self.assertNotIn("不允许任何人加群", plan["link_error"])

    def test_invitation_can_target_a_group_inside_the_member_view_scope(self):
        with patch.object(members, "fetch", side_effect=self.fetch), patch.object(member_actions.groups, "list_groups", side_effect=self.listing):
            plan = member_actions.preview(self, self.account, "snowluma", ["20", "10"], ["100", "200"],
                                          {"operation": "invite", "group_id": "20"})
        self.assertEqual(plan["rows"][0]["source"], "10")
        self.assertEqual(plan["rows"][1]["reason"], "已在目标群")

    def test_private_message_error_keeps_wording_for_generic_retcode(self):
        import io
        client = OneBotClient("http://localhost")
        response = b'{"status":"failed","retcode":100,"wording":"no such temp session"}'
        with patch.object(client._opener, "open", side_effect=lambda *_args, **_kwargs: io.BytesIO(response)):
            with self.assertRaisesRegex(AppError, "no such temp session"):
                client.call("send_private_msg", user_id=100)

    def test_moderation_rechecks_permission_and_never_expands_after_preview(self):
        with patch.object(members, "fetch", side_effect=self.fetch):
            plan = member_actions.preview(self, self.account, "snowluma", ["10"], ["99", "100", "200"],
                                          {"operation": "kick", "group_id": "10"})
            self.assertEqual(plan["ready"], 1)
            self.groups["10"]["100"]["role"] = "admin"
            self.groups["10"]["200"]["role"] = "member"
            tasks = member_actions.tasks(self, "99", plan)
            self.assertEqual([task["target"] for task in tasks], ["100"])
            self.assertIn("无权", tasks[0]["run"]())
            self.assertFalse(any(action == "set_group_kick" for action, _ in self.calls))

    def test_transport_cannot_apply_one_preview_twice(self):
        owner = ("test", self.account)
        req = lambda body: Request("POST", "", {}, body, {})
        with patch.object(api, "_result_owner", return_value=owner), \
                patch.object(api, "_active_client", return_value=(self, {})), \
                patch.object(api, "_session", return_value={"adapter": "snowluma"}), \
                patch.object(results, "STORE", results.ResultStore()), \
                patch.object(api.jobs.MANAGER, "submit", return_value={"id": "mock"}) as submit, \
                patch.object(members, "fetch", side_effect=self.fetch):
            entry = results.STORE.create(owner, {"entity": "memberships", "items": [{"id": "10:100", "qq": "100"}]},
                                         {"scope": {"group_ids": ["10"]}})
            payload = {"operation": "ban", "group_id": "10", "duration": 600, "query_id": entry["query_id"]}
            with self.assertRaisesRegex(AppError, "不在本次结果中"):
                api.api_member_action_preview(req({**payload, "selected": ["10:200"]}))
            plan = api.api_member_action_preview(req({**payload, "selected": ["10:100"]}))
            api.api_member_action_execute(req({"preview_id": plan["preview_id"]}))
            with self.assertRaisesRegex(AppError, "已失效"):
                api.api_member_action_execute(req({"preview_id": plan["preview_id"]}))
            submit.assert_called_once()
