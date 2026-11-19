"""对已勾选 QQ 做只读预演，确认后生成串行执行任务。"""
from functools import lru_cache
import re
from urllib.parse import urlsplit

from ..core.errors import AppError, NetworkError
from . import groups, groupsettings, members, rosters

LABELS = {"invite": "私发入群链接", "ban": "禁言", "kick": "移出成员"}
ACTIONS = {"invite": "send_private_msg", "ban": "set_group_ban", "kick": "set_group_kick"}


def group_ids(values):
    if not isinstance(values, list) or not values:
        raise AppError("请先选择来源群")
    ids = list(dict.fromkeys(map(str, values)))
    if any(not re.fullmatch(r"[1-9][0-9]*", item) for item in ids):
        raise AppError("群号无效")
    return ids


def read_sources(client, account, source_ids, progress=None):
    listing = groups.list_groups(client, account)
    group_names = {gid: groups.find(listing, gid).get("group_name") or gid for gid in source_ids}
    entries, errors = members.fetch_many(client, source_ids, force=True, on_progress=progress)
    if errors:
        gid, error = next(iter(errors.items()))
        raise AppError(f"无法读取来源群 {group_names[gid]} 的成员", hint=str(error))
    lists = {}
    for gid in source_ids:
        entry = entries[gid]
        actual = {member["qq"]: member for member in entry["members"]}
        if account not in actual or any(not re.fullmatch(r"[1-9][0-9]*", qq) for qq in actual):
            raise AppError(f"未取得来源群 {group_names[gid]} 的完整成员名单")
        lists[gid] = actual
    return group_names, lists


def selected_accounts(entry, selected):
    if entry["result"].get("entity") not in ("people", "memberships"):
        raise AppError("请从成员列表勾选账号")
    if not isinstance(selected, list) or not selected or not all(isinstance(item, str) for item in selected):
        raise AppError("请先勾选要操作的成员")
    rows = {item["id"]: item["qq"] for item in entry["result"]["items"]}
    if any(item not in rows for item in selected):
        raise AppError("部分勾选已不在本次结果中，请重新勾选")
    return group_ids(entry["spec"]["scope"]["group_ids"]), list(dict.fromkeys(rows[item] for item in selected))


def _qq_link(value):
    url = urlsplit(value)
    if url.scheme != "https" or url.netloc not in ("qm.qq.com", "qun.qq.com") or not url.path.strip("/"):
        raise AppError("请粘贴 QQ 客户端生成的 HTTPS 群分享链接")
    return value


def _block(operation, account, qq, actual):
    if qq == account:
        return "当前登录账号"
    if operation == "invite":
        return "已在目标群" if qq in actual else ""
    actor = actual[account].get("role")
    if actor not in ("admin", "owner"):
        return "当前账号没有管理权限"
    target = actual.get(qq)
    if not target:
        return "该成员已不在操作群"
    if target.get("role") == "owner" or (target.get("role") == "admin" and actor != "owner"):
        return "无权操作该成员"
    return ""


def _friend_ids(client):
    listing = client.call("get_friend_list")
    if not isinstance(listing, list):
        raise AppError("读取好友列表失败，暂未发送邀请")
    return {str(item.get("user_id")) for item in listing if isinstance(item, dict)}


def _closed_to_joining(client, group_id, info):
    option = groupsettings.group_add_option(info)
    if option is None:
        try:
            detail = client.call("get_group_detail_info", group_id=int(group_id), no_cache=True)
        except AppError:
            return False
        if isinstance(detail, dict):
            option = groupsettings.group_add_option(detail)
    return str(option) == str(groupsettings.ADD_MODES["closed"][0])


def preview(client, account, adapter, source_ids, recipients, payload, progress=None, tracking=None):
    operation = payload.get("operation")
    if operation not in LABELS or (tracking and operation != "invite"):
        raise AppError("成员操作无效")
    group_id = group_ids([payload.get("group_id")])[0]
    if operation != "invite" and group_id not in source_ids:
        raise AppError("操作群必须在成员查看范围内")
    duration = payload.get("duration")
    if operation == "ban" and (type(duration) is not int or not 1 <= duration <= 2592000):
        raise AppError("请输入 1 秒至 30 天的禁言时长")
    if progress:
        progress("读取操作群和最新成员")
    info = client.call("get_group_info", group_id=group_id, no_cache=True) or {}
    group_name = info.get("group_name") or group_id
    _, actual = rosters._latest(client, account, group_id, None)
    if operation == "invite":
        _, sources = read_sources(client, account, source_ids, progress)
    else:
        sources = {group_id: actual}

    rows = []
    for qq in recipients:
        source = next((gid for gid, people in sources.items() if qq in people), "")
        previous = (tracking or {}).get("delivery", {}).get(qq, "")
        reason = _block(operation, account, qq, actual)
        if not reason and not source:
            reason = "该成员已不在来源群"
        if not reason and previous == "sent":
            reason = "已处理过邀请"
        rows.append({"id": qq, "qq": qq, "source": source,
                     "label": (sources.get(source, {}).get(qq) or actual.get(qq) or {}).get("nickname", ""),
                     "reason": reason, "previous": previous})

    link, message, link_error = "", "", ""
    eligible = [row for row in rows if not row["reason"]]
    if operation == "invite" and eligible:
        manual_link = str(payload.get("link") or "").strip()
        if _closed_to_joining(client, group_id, info):
            link_error = "目标群设置为「不允许任何人加群」。如需通过链接加入，请先在 QQ 调整加群方式，再重新预演。"
        elif not manual_link:
            try:
                link = _qq_link(str((client.call("get_group_share_link", group_id=int(group_id)) or {}).get("url") or ""))
            except (AppError, ValueError):
                link_error = "无法自动取得群分享链接。请在 QQ 检查目标群的加群方式，允许加群后重新预演，或粘贴有效的群分享链接。"
        else:
            link = _qq_link(manual_link)
        if link:
            message = str(payload.get("message") or f"你好，请加入「{group_name}」（{group_id}）。\n{link}").strip()
            if link not in message:
                raise AppError("消息正文需要包含本次目标群链接")
            if adapter == "snowluma":
                try:
                    friends = _friend_ids(client)
                except AppError:
                    friends = None
                for row in eligible:
                    row["channel"] = "unknown" if friends is None else "friend" if row["qq"] in friends else "temporary"

    # 只有预演实际允许的账号可进入任务。后续复读不会扩大范围。
    return {"operation": operation, "group_id": group_id, "group_name": group_name, "source_ids": source_ids,
            "adapter": adapter, "duration": duration, "link": link, "message": message,
            "link_error": link_error, "rows": rows, "tracking_id": (tracking or {}).get("id"),
            "ready": len(eligible) if not link_error else 0}


def tasks(client, account, plan, roster_id=None):
    operation = plan["operation"]
    group_id = plan["group_id"]

    @lru_cache(maxsize=1)
    def current():
        try:
            login = client.call("get_login_info")
            if str((login or {}).get("user_id")) != account:
                raise AppError("登录账号已变更，请重新预演")
            _, actual = rosters._latest(client, account, group_id, None)
            sources = read_sources(client, account, plan["source_ids"])[1] if operation == "invite" else {}
            friends = set()
            if operation == "invite" and plan["adapter"] == "snowluma":
                friends = _friend_ids(client)
        except AppError as exc:
            return None, None, None, exc
        return actual, sources, friends, None

    def run(row):
        qq = row["qq"]
        actual, sources, friends, error = current()
        if error:
            raise error
        reason = _block(operation, account, qq, actual)
        if reason:
            if roster_id and reason == "已在目标群":
                rosters.record_delivery(account, roster_id, group_id, qq, "already")
            return reason
        if operation == "invite":
            source = row["source"]
            if qq not in sources.get(source, {}):
                rosters.record_delivery(account, roster_id, group_id, qq, "manual")
                return "成员已离开预演中的来源群"
            if not rosters.claim_delivery(account, roster_id, group_id, qq):
                return "该账号的邀请已发送或正在处理"
            params = {"user_id": int(qq), "message": [{"type": "text", "data": {"text": plan["message"]}}]}
            temporary = plan["adapter"] == "snowluma" and qq not in friends
            if temporary:
                params["group_id"] = int(source)
            delivery = "unknown"
            try:
                client.call(ACTIONS[operation], **params)
                delivery = "sent"
            except NetworkError as exc:
                raise AppError("发送结果未知，请核对后再决定是否重试") from exc
            except AppError as exc:
                if exc.retcode is not None or exc.code == "UNSUPPORTED":
                    delivery = "manual"
                    if temporary and "no such temp session" in exc.message.casefold():
                        raise AppError("SnowLuma 未找到可用的群临时会话",
                                       hint="请在 QQ 中手动邀请，或让对方先发起临时会话。",
                                       retcode=exc.retcode) from exc
                    raise
                raise AppError("发送结果未知，请核对后再决定是否重试") from exc
            finally:
                rosters.finish_delivery(account, roster_id, group_id, qq, delivery)
        else:
            params = {"group_id": int(group_id), "user_id": int(qq)}
            params.update({"duration": plan["duration"]} if operation == "ban" else {"reject_add_request": False})
            try:
                client.call(ACTIONS[operation], **params)
            except NetworkError as exc:
                raise AppError("操作结果未知，请核对群状态后再决定是否重试") from exc
        return None

    return [{"action": ACTIONS[operation], "target": row["qq"], "label": row["label"],
             "params": {"group_id": group_id}, "run": lambda row=row: run(row)}
            for row in plan["rows"] if not row["reason"]]
