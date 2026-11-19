import * as api from './api.js';
import { state } from './state.js';
import { esc, openDrawer, closeDrawer, toast } from './ui.js';
import { jobBanner, names, requestData } from './workspace.js';

const SWITCH = [['keep', '不修改'], ['on', '开启'], ['off', '关闭']];
const ADD = [['keep', '不修改'], ['open', '允许任何人加群'], ['closed', '不允许任何人加群'], ['approve', '需要发送验证消息'], ['question_approve', '回答问题并由管理员审核'], ['question', '正确回答问题自动加入']];
const INVITE = [['keep', '不修改'], ['disabled', '禁止群成员邀请好友'], ['require_approval', '允许邀请，需管理员审核'], ['no_approval', '允许邀请，无需审核'], ['no_approval_under_100', '群人数少于 100 时无需审核']];
const options = values => values.map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join('');
const select = (id, label, values, extra = '') => `<div class="field ${extra}"><label for="${id}">${label}</label><select class="input" id="${id}">${options(values)}</select></div>`;

export function settingsVisibility(mode, adminMode, target, kick) {
  return { question: ['question', 'question_approve'].includes(mode), answer: mode === 'question',
    admin: adminMode !== 'keep', target: adminMode === 'permissions',
    ids: ['add', 'remove'].includes(adminMode) || adminMode === 'permissions' && target === 'specified',
    permissions: adminMode === 'permissions', memberPermissions: target !== 'owner', limit: adminMode === 'permissions' && target !== 'owner' && kick === 'on' };
}

export function openGroupSettings(groupIds, progressElement, onFinish) {
  groupIds = [...new Set(groupIds)];
  if (!groupIds.length) { toast('请先选择群聊', 'warn'); return; }
  let diff = null, revision = 0, busy = false;
  const groupNames = names(groupIds);
  openDrawer({ title: `批量群设置 · ${groupIds.length} 个群`, wide: true,
    body: `<div class="group-settings">
      <details class="settings-targets"><summary><strong>操作目标 · ${groupIds.length} 个群</strong><span>${esc(groupNames.slice(0, 2).join('、'))}${groupIds.length > 2 ? '…' : ''}</span><small>展开核对群号与身份</small></summary><ul>${groupIds.map((gid, i) => {
        const role = state.groups.find(group => group.group_id === gid)?.my_role;
        return `<li><strong>${esc(groupNames[i])}</strong><span class="mono">${esc(gid)}</span><span>${({ owner: '群主', admin: '管理员', member: '普通成员' })[role] || '身份待确认'}</span></li>`;
      }).join('')}</ul></details>
      <div class="settings-template-bar"><div class="field"><label for="setting-saved">已保存模板</label><select class="input" id="setting-saved"></select></div><div class="field"><label for="setting-name">模板名称</label><input class="input" id="setting-name" value="群设置模板"/></div><div class="settings-template-actions"><button class="btn btn-sm" id="setting-save">保存模板</button><button class="btn btn-sm" id="setting-copy">另存为新模板</button><button class="btn btn-sm btn-text" id="setting-delete">删除模板</button></div></div>
      <div id="setting-read-progress" hidden></div><div class="settings-layout"><div class="settings-editor"><div class="settings-tabs" role="tablist" aria-label="群设置分类">${[['basic', '基本资料'], ['join', '加群与邀请'], ['admin', '管理员']].map(([id, label], i) => `<button type="button" role="tab" id="settings-tab-${id}" aria-controls="settings-panel-${id}" aria-selected="${!i}" tabindex="${i ? -1 : 0}" data-settings-tab="${id}">${label}</button>`).join('')}</div>
      <form id="settings-form"><section id="settings-panel-basic" role="tabpanel" aria-labelledby="settings-tab-basic" data-settings-panel="basic"><h3>基本资料</h3><p class="settings-help">留空表示保留原值。群名称和公告支持 {group_name}、{group_id}。</p><div class="settings-form-grid">
        <div class="field settings-wide"><label for="setting-group-name">群名称</label><input class="input" id="setting-group-name" placeholder="留空不修改"/></div>
        <div class="field settings-wide"><label for="setting-portrait">群头像</label><input class="input" id="setting-portrait" placeholder="本地绝对路径或图片直链"/></div>
        ${select('setting-whole-ban', '全员禁言', SWITCH)}
        ${select('setting-search', '通过群号搜索', [['keep', '不修改'], ['on', '允许'], ['off', '禁止']])}
        <div class="field settings-wide"><label for="setting-notice">发布群公告</label><textarea class="textarea" id="setting-notice" rows="4" placeholder="留空不发布；填写后将新增一条公告"></textarea></div></div></section>
      <section id="settings-panel-join" role="tabpanel" aria-labelledby="settings-tab-join" data-settings-panel="join" hidden><h3>加群与邀请</h3><p class="settings-help">选择加群方式后，仅填写该方式需要的问题和答案。</p><div class="settings-form-grid">
        ${select('setting-add-mode', '加群方式', ADD, 'settings-wide')}
        <div class="field settings-wide" id="setting-question-field" hidden><label for="setting-question">验证问题</label><input class="input" id="setting-question" placeholder="例如：班级姓名"/></div>
        <div class="field settings-wide" id="setting-answer-field" hidden><label for="setting-answer">正确答案</label><input class="input" id="setting-answer" placeholder="回答正确后自动加入"/></div>
        <p class="settings-help settings-wide" id="setting-join-help"></p>
        ${select('setting-invite', '群成员邀请好友加群', INVITE, 'settings-wide')}
        <p class="settings-help settings-wide">禁止成员邀请时，只有群主和管理员可以分享群聊、邀请好友。</p></div></section>
      <section id="settings-panel-admin" role="tabpanel" aria-labelledby="settings-tab-admin" data-settings-panel="admin" hidden><h3>管理员管理</h3><p class="settings-help">逐群检查目标成员和当前账号身份；管理员增删及权限修改需要群主操作。</p><div class="settings-capability" id="setting-admin-capability"></div><div class="settings-form-grid">
        ${select('setting-admin-mode', '批量操作', [['keep', '不修改'], ['add', '添加管理员'], ['remove', '取消管理员'], ['permissions', '修改管理员权限']], 'settings-wide')}
        <div id="setting-admin-target-field" class="settings-wide" hidden>${select('setting-admin-target', '权限应用范围', [['specified', '指定 QQ'], ['all', '各群全部现有管理员'], ['owner', '各群群主（仅验证消息提醒）']])}</div>
        <div class="field settings-wide" id="setting-admin-ids-field" hidden><label for="setting-admin-ids">目标 QQ 号</label><textarea class="textarea mono" id="setting-admin-ids" rows="3" placeholder="每行一个，或用逗号分隔；相同 QQ 应用到各目标群"></textarea></div>
        <p class="settings-help settings-wide" id="setting-admin-help" hidden></p>
        <div class="settings-permissions settings-wide" id="setting-permissions" hidden>
          ${select('setting-receive', '接收验证消息', SWITCH)}
          <div id="setting-recall-field">${select('setting-recall', '撤回成员消息', SWITCH)}</div>
          <div id="setting-kick-field">${select('setting-kick', '移除群成员', SWITCH)}</div>
          <div id="setting-limit-field" hidden>${select('setting-limit', '每日可移除人数', [0, 5, 10, 20, 50, 100, 200].map(n => [n, n ? `${n} 人／日` : '不限制']))}</div>
        </div></div></section></form>
      <button type="button" class="btn btn-sm btn-text" id="setting-reset">重置为全部不修改</button></div>
      <section class="settings-preview" aria-label="群设置差异预演"><div class="settings-preview-title"><h3>变更预演</h3><span id="setting-preview-status" role="status">尚未预演</span></div><div id="setting-diff" aria-live="polite"><div class="settings-preview-empty"><strong>先配置，再核对</strong><p>选择需要修改的项目，点击「预演差异」。这里会逐群列出旧值、新值及跳过原因。</p><small>预演只读取资料，不会修改 QQ 群。</small></div></div></section></div></div>`,
    footer: '<span class="rename-error" role="alert"></span><span class="spacer"></span><button class="btn" data-close="1">关闭</button><button class="btn btn-primary" id="setting-preview">预演差异</button><button class="btn btn-primary" id="setting-execute" disabled>执行变更</button>',
    onMount(panel, foot) {
      const root = panel.querySelector('.group-settings');
      const get = id => root.querySelector(`#setting-${id}`);
      const form = root.querySelector('#settings-form');
      const execute = foot.querySelector('#setting-execute');
      const preview = foot.querySelector('#setting-preview'), errorLine = foot.querySelector('.rename-error');
      const alive = () => root.isConnected && root.closest('.drawer')?.getAttribute('aria-hidden') === 'false';
      const showTab = tab => {
        root.querySelectorAll('[data-settings-tab]').forEach(button => { const active = button.dataset.settingsTab === tab; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
        root.querySelectorAll('[data-settings-panel]').forEach(section => { section.hidden = section.dataset.settingsPanel !== tab; });
      };
      root.querySelectorAll('[data-settings-tab]').forEach(button => {
        button.addEventListener('click', () => showTab(button.dataset.settingsTab));
        button.addEventListener('keydown', event => {
          const tabs = [...root.querySelectorAll('[data-settings-tab]')];
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(button) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
          showTab(tabs[index].dataset.settingsTab); tabs[index].focus();
        });
      });
      const paintTemplates = (id = '') => {
        get('saved').innerHTML = '<option value="">不使用已保存模板</option>' + (state.config?.templates || []).map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
        get('saved').value = id;
        get('delete').disabled = !id || busy;
        get('save').textContent = id ? '更新模板' : '保存模板';
      };
      const sync = () => {
        const visible = settingsVisibility(get('add-mode').value, get('admin-mode').value, get('admin-target').value, get('kick').value);
        for (const [field, key] of [['question-field', 'question'], ['answer-field', 'answer'], ['admin-target-field', 'target'], ['admin-ids-field', 'ids'], ['permissions', 'permissions'], ['recall-field', 'memberPermissions'], ['kick-field', 'memberPermissions'], ['limit-field', 'limit'], ['admin-help', 'admin']]) get(field).hidden = !visible[key];
        for (const id of ['question', 'answer', 'admin-ids']) { const active = visible[id === 'admin-ids' ? 'ids' : id]; get(id).disabled = busy || !active; get(id).required = active; }
        get('limit').disabled = busy || !visible.limit;
        get('join-help').textContent = ({ open: '申请人可直接加入，无需验证。', closed: '不接受新的加群申请。', approve: '申请人发送验证消息，由群主或管理员审核。', question_approve: '申请人回答问题后仍需管理员审核，无需设置标准答案。', question: '答案匹配后自动加入，无需人工审核。' })[get('add-mode').value] || '';
        get('admin-help').textContent = get('admin-mode').value === 'permissions' ? '只修改明确选择的权限。「不修改」保留各管理员的现有权限。开启移除权限时，请同时选择每日人数上限。' : '已是管理员、未加入本群、群主及权限不足的项目会在预演中说明；不会移除群成员。';
        execute.disabled = busy || !diff?.total_changes;
        execute.textContent = diff?.total_changes ? `执行 ${diff.total_changes} 项变更` : '执行变更';
      };
      const setBusy = value => {
        busy = value;
        root.querySelectorAll('input, textarea, select, button').forEach(input => { input.disabled = value; });
        preview.disabled = value; preview.textContent = value ? '处理中…' : '预演差异';
        paintTemplates(get('saved').value); sync();
      };
      const invalidate = () => {
        revision++; diff = null; errorLine.textContent = '';
        get('preview-status').textContent = '配置已更改，请重新预演';
        get('diff').innerHTML = '<div class="settings-preview-empty"><strong>等待预演</strong><p>当前配置尚未核对，点击「预演差异」读取各群的实际设置。</p></div>';
        sync();
      };
      const read = () => ({ name: get('name').value.trim(), group_name: get('group-name').value, portrait: get('portrait').value, notice: get('notice').value,
        whole_ban: get('whole-ban').value, search_option: get('search').value, invite_policy: get('invite').value,
        add_option: { mode: get('add-mode').value, question: get('question').value, answer: get('answer').value },
        admin: { mode: get('admin-mode').value, target: get('admin-target').value, user_ids: get('admin-ids').value,
          permissions: { receive_verify: get('receive').value, recall_member_message: get('recall').value, kick_member: get('kick').value, kick_member_per_day: Number(get('limit').value) } } });
      const load = (saved = {}) => {
        form.reset(); get('name').value = saved.name || '群设置模板';
        for (const [id, key] of [['group-name', 'group_name'], ['portrait', 'portrait'], ['notice', 'notice'], ['whole-ban', 'whole_ban'], ['search', 'search_option'], ['invite', 'invite_policy']]) get(id).value = saved[key] ?? (['whole-ban', 'search', 'invite'].includes(id) ? 'keep' : '');
        get('add-mode').value = saved.add_option?.mode || 'keep'; get('question').value = saved.add_option?.question || ''; get('answer').value = saved.add_option?.answer || '';
        const admin = saved.admin || {};
        get('admin-mode').value = admin.mode || 'keep'; get('admin-target').value = admin.target || 'specified';
        get('admin-ids').value = Array.isArray(admin.user_ids) ? admin.user_ids.join('\n') : admin.user_ids || '';
        for (const [id, key] of [['receive', 'receive_verify'], ['recall', 'recall_member_message'], ['kick', 'kick_member']]) get(id).value = admin.permissions?.[key] || 'keep';
        get('limit').value = admin.permissions?.kick_member_per_day ?? 0;
        invalidate();
      };
      const validate = () => {
        const invalid = form.querySelector(':invalid');
        if (invalid) { showTab(invalid.closest('[data-settings-panel]').dataset.settingsPanel); invalid.reportValidity(); return false; }
        return true;
      };
      form.addEventListener('submit', event => event.preventDefault());
      form.addEventListener('input', invalidate);
      form.addEventListener('change', invalidate);
      get('saved').addEventListener('change', () => { const id = get('saved').value; load((state.config?.templates || []).find(item => item.id === id)); paintTemplates(id); });
      get('reset').addEventListener('click', () => { load(); paintTemplates(); });
      const save = async asNew => {
        if (!validate() || busy) return;
        if (!get('name').value.trim()) { get('name').focus(); errorLine.textContent = '请填写模板名称'; return; }
        const template = read(); if (!asNew && get('saved').value) template.id = get('saved').value;
        setBusy(true); errorLine.textContent = '';
        try {
          const data = await api.post('/api/templates', { template }); state.config = { ...state.config, ...data.config };
          if (alive()) { paintTemplates(data.template.id); toast(asNew ? '已另存为新模板' : '群设置模板已保存', 'ok'); }
        } catch (error) { if (alive()) errorLine.textContent = `${error.message} ${error.hint || ''}`; }
        finally { if (alive()) setBusy(false); }
      };
      get('save').addEventListener('click', () => save(false)); get('copy').addEventListener('click', () => save(true));
      get('delete').addEventListener('click', async () => {
        const id = get('saved').value;
        if (!id || busy || !window.confirm(`删除模板「${get('name').value}」？当前表单内容会保留。`)) return;
        setBusy(true);
        try { const config = await api.del(`/api/templates/${encodeURIComponent(id)}`); state.config = { ...state.config, ...config }; if (alive()) { paintTemplates(); toast('模板已删除', 'ok'); } }
        catch (error) { if (alive()) errorLine.textContent = error.message; }
        finally { if (alive()) setBusy(false); }
      });
      const capabilities = [];
      if (!state.caps.admin_permissions) capabilities.push('当前协议端不支持撤回、移除及每日人数权限设置。');
      if (!state.caps.admin_receive_verify) capabilities.push('当前协议端不支持验证消息接收开关。');
      get('admin-capability').textContent = capabilities.length ? `${capabilities.join('')}细分权限需要支持这些扩展接口的 SnowLuma；预演会标出不支持项。` : '当前协议端支持单个管理员的细分权限。';
      paintTemplates(); sync();
      preview.addEventListener('click', async () => {
        if (busy || !validate()) return;
        const template = read(), ticket = ++revision;
        diff = null; errorLine.textContent = ''; setBusy(true);
        get('preview-status').textContent = '正在读取各群设置…';
        try {
          const data = await requestData('/api/settings/preview', { group_ids: groupIds, template }, job => { if (ticket === revision && alive()) jobBanner(get('read-progress'), job); });
          if (ticket !== revision || !alive()) return;
          diff = data;
          get('preview-status').textContent = data.total_changes ? '预演完成，可执行变更' : '没有可执行的变更';
          get('diff').innerHTML = `<div class="preview-summary"><strong>${diff.total_changes} 项变更</strong><span>${diff.groups.length} 个群 · ${diff.skipped || 0} 项跳过</span></div>${diff.warnings.map(warning => `<p class="text-warn small">${esc(warning)}</p>`).join('')}${diff.groups.map(group => `<details class="setting-group-diff" open><summary><strong>${esc(group.group_name)}</strong><span class="mono">${esc(group.group_id)}</span><small>${group.actionable} 项变更 · ${group.skipped} 项跳过</small></summary>${group.fields.map(field => `<div class="setting-diff-item ${!field.supported ? 'is-skipped' : field.changed ? 'is-changed' : ''}"><div><strong>${esc(field.label)}</strong><span class="tag ${!field.supported ? 'tag-ghost' : field.changed ? 'tag-teal' : 'tag-ghost'}">${!field.supported ? '跳过' : field.changed ? '将修改' : '无需修改'}</span></div><p class="old-value">原值：${esc(field.from)}</p><p class="new-value">目标：${esc(field.to)}</p>${field.note ? `<p class="settings-diff-note">${esc(field.note)}</p>` : ''}</div>`).join('')}</details>`).join('')}`;
        } catch (error) { if (ticket === revision && alive()) { errorLine.textContent = `${error.message} ${error.hint || ''}`; get('preview-status').textContent = '预演失败，可修改后重试'; } }
        finally { if (alive()) setBusy(false); }
      });
      execute.addEventListener('click', async () => {
        if (busy || !diff?.total_changes) return;
        setBusy(true); errorLine.textContent = '';
        try {
          const data = await api.post('/api/settings/execute', { preview_id: diff.preview_id, interval: state.config?.batch?.interval });
          if (alive()) closeDrawer();
          toast(`已提交 ${data.planned} 项群设置变更`, 'ok', '可在任务中心查看逐项结果');
          await api.pollJob(data.job.id, job => jobBanner(progressElement, job));
          await onFinish?.();
        } catch (error) { if (alive()) { invalidate(); errorLine.textContent = `${error.message} ${error.hint || ''}`; setBusy(false); } else toast(error.message, 'err', error.hint); }
      });
    },
  });
}
