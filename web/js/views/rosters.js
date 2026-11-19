import * as api from '../api.js';
import { state, loadPrefs, savePrefs } from '../state.js';
import { esc, toast, fmtNumber, openDrawer, closeDrawer, confirmAction, actionMenu } from '../ui.js';
import { initialize, requestData, jobBanner, errorBox, ResultQuery, workspaceTabs } from '../workspace.js';
import { ResultTable, dataColumns, readResultIds, retainSelection } from '../result-table.js';
import { fieldStatusTag, groupTag } from '../field-display.js';
import { filePayload, openMemberAction } from '../member-actions.js';
import { routeParams } from '../router.js';

import { mountChoices, mountGroupSelect, mountQueryBar } from '../search-controls.js';
import { mountResultActions } from '../result-controls.js';

let disposeView;
const TRACKING_STATUS = [['all', '全部'], ['not_joined', '未入群'], ['joined', '已入群'], ['left', '已退群'], ['unknown', '待核对']];
const STATUS_TONES = { joined: 'success', missing: 'warning', left: 'danger', unknown: 'pending' };
const STATUS_LABELS = { joined: '已入群', missing: '未入群', left: '已退群', unknown: '待核对' };

export function rosterColumns(data, selected, search = '') {
  return dataColumns(data, { selected, detail: false, search }).map(column => column.key === 'roster.status'
    ? { ...column, width: 120, render: row => fieldStatusTag(STATUS_LABELS[row.status], STATUS_TONES[row.status]) }
    : column);
}

function importRoster(onSaved) {
  openDrawer({ title: '按名单建群 · 导入名单', wide: true,
    body: `<div class="roster-import"><p class="settings-help">使用成员导出的 CSV、XLSX，或粘贴“复制表格”的内容。保留表头和 QQ号列，按 QQ号合并重复人员。</p>
      <div class="roster-form"><label>建群计划名称<input class="input" id="roster-name" placeholder="例如：26级活动通知群"/></label>
      <label>选择名单文件<input class="input roster-file" type="file" id="roster-file" accept=".csv,.tsv,.txt,.xlsx"/></label>
      <label>或直接粘贴表格<textarea class="textarea mono" rows="5" id="roster-text" placeholder="QQ号&#9;昵称&#9;群昵称&#10;123456789&#9;张三&#9;26级-张三"></textarea></label></div>
      <div class="roster-preview-head"><button class="btn" id="roster-read">读取并预览</button><span class="tiny muted" id="roster-import-count">先读取名单，再保存计划。</span></div>
      <div id="roster-import-error" role="status"></div><div id="roster-preview"></div></div>`,
    footer: '<button class="btn" data-close="1">取消</button><button class="btn btn-primary" id="roster-save" disabled>保存建群计划</button>',
    onMount(panel, foot) {
      const form = panel.querySelector('.roster-import');
      const file = form.querySelector('#roster-file'), text = form.querySelector('#roster-text');
      const count = form.querySelector('#roster-import-count'), errors = form.querySelector('#roster-import-error');
      const save = foot.querySelector('#roster-save'), read = form.querySelector('#roster-read');
      let payload = null, list;
      const busy = value => { for (const input of [file, text, read, save]) input.disabled = value; if (!value) save.disabled = !payload; };
      const invalidate = () => { payload = null; save.disabled = true; count.textContent = '名单已变更，请重新读取。'; list?.destroy(); form.querySelector('#roster-preview').innerHTML = ''; errors.innerHTML = ''; };
      file.addEventListener('change', () => {
        text.value = ''; invalidate();
        if (file.files[0] && !form.querySelector('#roster-name').value.trim()) form.querySelector('#roster-name').value = file.files[0].name.replace(/\.[^.]+$/, '');
      });
      text.addEventListener('input', () => { file.value = ''; invalidate(); });
      read.addEventListener('click', async () => {
        busy(true); payload = null; errors.innerHTML = ''; count.textContent = '正在读取名单…';
        list?.destroy(); form.querySelector('#roster-preview').innerHTML = '';
        try {
          const source = file.files[0] ? await filePayload(file.files[0]) : { text: text.value };
          const data = await api.post('/api/rosters/import', source);
          if (!form.isConnected) return;
          payload = source; list?.destroy();
          list = new ResultTable(form.querySelector('#roster-preview'), { layoutKey: 'roster-import' });
          list.setData(data, rosterColumns(data));
          count.textContent = `有效名单 ${fmtNumber(data.roster.count)} 人 · 合并重复记录 ${fmtNumber(data.roster.duplicates)} 条`;
        } catch (error) { if (form.isConnected) { errors.innerHTML = errorBox(error); count.textContent = '名单未读取，请检查后重试。'; } }
        finally { if (form.isConnected) busy(false); }
      });
      save.addEventListener('click', async () => {
        if (!payload) return;
        busy(true); errors.innerHTML = '';
        try {
          const roster = await api.post('/api/rosters', { ...payload, name: form.querySelector('#roster-name').value.trim() });
          if (form.isConnected) closeDrawer();
          toast('建群计划已保存，请在 QQ 建群后绑定群号', 'ok');
          await onSaved(roster);
        } catch (error) { if (form.isConnected) errors.innerHTML = errorBox(error); }
        finally { if (form.isConnected) busy(false); }
      });
    },
  });
}

function bindRoster(roster, onBound) {
  openDrawer({ title: '绑定 QQ群',
    body: `<div class="roster-bind"><p class="settings-help">在 QQ 中创建群聊后，填写群号或从当前账号的群列表中选择。绑定时会立即读取成员并核对名单。</p>
      <div class="roster-form"><label>目标群号<input class="input mono" id="roster-group-id" inputmode="numeric" value="${esc(roster.group_id || '')}"/></label>
      <div id="roster-group-picker"></div></div>
      ${roster.group_id ? '<p class="settings-help">换绑到其他群时，将重新开始记录首次确认入群时间。</p>' : ''}<div id="roster-bind-progress" hidden></div></div>`,
    footer: '<button class="btn" data-close="1">取消</button><button class="btn btn-primary" id="roster-bind-save">绑定并核对</button>',
    onMount(panel, foot) {
      const form = panel.querySelector('.roster-bind'), button = foot.querySelector('#roster-bind-save');
      const input = form.querySelector('#roster-group-id');
      const picker = mountGroupSelect(form.querySelector('#roster-group-picker'), {
        groups: state.groups, label: '从已加入的群中选择', value: input.value, onChange(value) { input.value = value; },
      });
      input.addEventListener('change', () => picker.setValue(input.value.trim()));
      button.addEventListener('click', async () => {
        button.disabled = input.disabled = true;
        picker.setDisabled(true);
        try {
          const updated = await requestData(`/api/rosters/${roster.id}/bind`, { group_id: input.value.trim() }, job => jobBanner(form.querySelector('#roster-bind-progress'), job));
          if (form.isConnected) closeDrawer();
          toast('群聊已绑定，入群名单已更新', 'ok');
          await onBound(updated);
        } catch (error) { if (form.isConnected) { const progress = form.querySelector('#roster-bind-progress'); progress.hidden = false; progress.innerHTML = errorBox(error); } }
        finally {
          if (form.isConnected) { button.disabled = input.disabled = false; picker.setDisabled(false); }
        }
      });
    },
  });
}

export async function render(container) {
  await initialize(container);
  const prefsKey = `rosters.${state.session?.login?.user_id || 'local'}`;
  const prefs = loadPrefs()[prefsKey] || {};
  const params = routeParams();
  let activeId = params.get('plan') || prefs.activeId || '', automatic = prefs.automatic !== false;
  let plans = [], data, list, plansLoading = false, syncing = false, timer, watchedJob;
  let status = 'all', search = '', sort = { field: 'member.qq', desc: false };
  const selected = new Set();
  container.innerHTML = `<div class="page rosters-page"><div class="page-head">${workspaceTabs('lists', 'lists')}<div class="page-actions">
    <a class="btn" href="#/members">从成员发起邀请</a><button class="btn btn-primary" id="roster-new">导入 QQ 名单</button></div></div>
    <div class="roster-layout"><aside class="roster-plans" id="roster-plans" aria-label="已保存的建群计划"></aside>
      <section class="workspace-card roster-results"><div class="roster-detail-head">
        <div><h2 id="roster-title">选择或导入名单</h2><div id="roster-group" class="tiny muted"></div></div>
        <div class="page-actions"><button class="btn btn-sm" id="roster-bind" hidden>绑定群号</button>
        <button class="btn btn-sm" id="roster-sync" hidden>立即核对</button>
        <label class="check-inline" id="roster-auto-label" hidden><input type="checkbox" id="roster-auto" ${automatic ? 'checked' : ''}/>每 30 秒核对</label>
        ${actionMenu('更多', '<button class="btn btn-sm btn-danger" id="roster-delete" disabled>删除本地计划</button>')}</div></div>
      <div id="roster-summary" class="roster-summary" role="status"></div>
      <div id="roster-alert" role="status"></div><div id="roster-sync-progress" hidden></div>
      <div id="roster-query"></div><div id="roster-actions"></div>
      <div id="roster-job" hidden></div><div id="roster-progress" hidden></div><div id="roster-operation" hidden></div><div id="roster-table"></div>
    </section></div></div>`;
  const root = container.querySelector('.rosters-page');
  const host = root.querySelector('#roster-table');
  const planHost = root.querySelector('#roster-plans');
  const syncProgress = root.querySelector('#roster-sync-progress');
  const jobProgress = root.querySelector('#roster-job');
  const active = () => plans.find(plan => plan.id === activeId);
  const save = () => savePrefs({ [prefsKey]: { activeId, automatic } });
  const upsert = plan => { plans = [plan, ...plans.filter(item => item.id !== plan.id)].sort((a, b) => b.created_at - a.created_at); };
  const query = new ResultQuery(root.querySelector('#roster-progress'), {
    isActive: () => root.isConnected,
    onChange: selection,
  });
  const actions = mountResultActions(root.querySelector('#roster-actions'), {
    selected, onClear: clear, progress: root.querySelector('#roster-operation'),
    tools: '<button class="btn btn-sm" id="roster-resend" hidden>继续邀请</button>',
  });
  const bar = mountQueryBar(root.querySelector('#roster-query'), {
    search: { label: '搜索入群名单', placeholder: '搜索 QQ号、昵称或名单内容',
      onSubmit(value) { search = value; clear(); load(); } },
    tools: '<div id="roster-status"></div>',
  });
  const statusChoices = mountChoices(root.querySelector('#roster-status'), {
    label: '入群状态', onChange(value) { status = value; clear(); load(); },
  });

  function selection() {
    if (!root.isConnected) return;
    const plan = active();
    const busy = plansLoading || query.loading || syncing || Boolean(list?.selectionBusy);
    actions.update({
      data, ready: query.ready, busy, unit: '人',
      label: data && data.roster.id !== activeId ? `${data.roster.name} · ${fmtNumber(data.total)} 人` : undefined,
    });
    list?.setLoading(plansLoading || syncing || !query.ready);
    root.querySelector('#roster-new').disabled = plansLoading || syncing;
    for (const id of ['roster-bind', 'roster-delete']) root.querySelector('#' + id).disabled = busy || !plan;
    root.querySelector('#roster-sync').disabled = busy || !plan?.group_id;
    root.querySelector('#roster-resend').disabled = !actions.usable();
    root.querySelector('#roster-auto').disabled = !plan?.group_id;
    planHost.querySelectorAll('[data-roster]').forEach(button => { button.disabled = syncing || plansLoading; });
    bar.search.setDisabled(!plan);
  }
  function clear() {
    selected.clear();
    actions.resetRange();
    list?.schedule();
    selection();
  }
  function resetCriteria() {
    status = 'all';
    search = '';
    sort = { field: 'member.qq', desc: false };
    bar.search.setValue('');
    jobProgress.hidden = true;
    clear();
  }
  function paintPlans() {
    planHost.innerHTML = plans.length ? plans.map(plan => `<button class="comparison-target ${plan.id === activeId ? 'active' : ''}" data-roster="${esc(plan.id)}" aria-pressed="${plan.id === activeId}">
      <strong>${esc(plan.name)}</strong><span>${plan.group_id ? esc(`${plan.group_name}（${plan.group_id}）`) : '待在 QQ 建群并绑定'}</span>
      <small>名单 ${fmtNumber(plan.count)} 人 · 已入群 ${fmtNumber(plan.joined)}${plan.unknown ? ` · 待核对 ${fmtNumber(plan.unknown)}` : ` · 未入群 ${fmtNumber(plan.not_joined)}`}</small></button>`).join('')
      : '<p class="roster-plans-empty">暂无建群计划</p>';
  }
  function paintHeader() {
    const plan = active();
    root.querySelector('#roster-title').textContent = plan?.name || '选择或导入名单';
    root.querySelector('#roster-group').innerHTML = plan?.group_id
      ? `${groupTag(plan.group_name, plan.group_id)} <span class="mono">${esc(plan.group_id)}</span>`
      : plan ? '在 QQ 建好群后，绑定群号开始核对。' : '';
    const bind = root.querySelector('#roster-bind');
    bind.textContent = plan?.group_id ? '更换绑定群' : '绑定群号';
    bind.hidden = !plan || Boolean(plan.invitation);
    root.querySelector('#roster-resend').hidden = !plan?.invitation;
    root.querySelector('#roster-sync').hidden = root.querySelector('#roster-auto-label').hidden = !plan?.group_id;
    root.querySelector('#roster-summary').innerHTML = plan ? `<div class="roster-counts"><span>应到 <strong>${fmtNumber(plan.count)}</strong></span>
      <span class="roster-joined">已入群 <strong>${fmtNumber(plan.joined)}</strong></span><span>未入群 <strong>${fmtNumber(plan.not_joined)}</strong>${plan.left ? `（含已退群 ${fmtNumber(plan.left)}）` : ''}</span>
      ${plan.unknown ? `<span>待核对 <strong>${fmtNumber(plan.unknown)}</strong></span>` : ''}<span class="spacer"></span><span>${plan.count ? Math.round(plan.joined / plan.count * 100) : 0}% 已入群</span></div>
      <progress max="${plan.count}" value="${plan.joined}" aria-label="入群进度"></progress>` : '';
    root.querySelector('#roster-alert').innerHTML = plan?.last_error ? `<div class="query-error roster-sync-error" role="alert"><strong>最近核对失败，保留上次成功结果</strong><p>${esc(plan.last_error)}</p></div>` : '';
  }
  function paintStatus() {
    const choices = active()?.invitation ? [...TRACKING_STATUS, ['manual', '待手动处理']] : TRACKING_STATUS;
    statusChoices.setChoices(active() ? choices : [], status);
  }
  function load(preserveScroll = false) {
    if (!root.isConnected) return;
    if (!active()) {
      list?.destroy();
      list = data = null;
      host.innerHTML = '<div class="empty"><strong>导入名单以创建跟踪计划</strong></div>';
      query.reset();
      return;
    }
    const id = activeId;
    return query.run(async (report, current) => {
      const response = await requestData(`/api/rosters/${id}/query`, { status, search, sort }, report, current);
      if (!current()) return;
      const selectionIds = selected.size ? await readResultIds(response) : null;
      return { response, selectionIds };
    }, ({ response, selectionIds }) => {
      const position = preserveScroll && list ? { top: list.viewport.scrollTop, left: list.viewport.scrollLeft } : null;
      if (selectionIds) retainSelection(selected, selectionIds);
      data = selectionIds ? { ...response, selection_ids: selectionIds } : response;
      upsert(data.roster);
      list?.destroy();
      list = new ResultTable(host, {
        selected, sort, layoutKey: 'roster', onSelection: selection, onReload: () => load(),
        onSort: field => { sort = { field, desc: sort.field === field ? !sort.desc : false }; load(); },
      });
      list.setData(data, rosterColumns(data, selected, search));
      paintPlans();
      paintHeader();
      if (position) {
        const current = list;
        requestAnimationFrame(() => {
          if (list !== current || current.disposed) return;
          current.viewport.scrollTop = position.top;
          current.viewport.scrollLeft = position.left;
        });
      }
    }, () => load(preserveScroll));
  }
  function arm() {
    clearTimeout(timer);
    if (!root.isConnected || !automatic || !active()?.group_id) return;
    timer = setTimeout(() => {
      if (document.visibilityState === 'visible' && document.getElementById('drawer')?.getAttribute('aria-hidden') !== 'false') sync(true);
      else arm();
    }, 30000);
  }
  async function sync(quiet = false) {
    if (!root.isConnected || syncing || query.loading || plansLoading || list?.selectionBusy) { arm(); return; }
    const plan = active();
    if (!plan?.group_id) return;
    clearTimeout(timer);
    syncing = true;
    selection();
    const current = () => root.isConnected && activeId === plan.id;
    try {
      const updated = await requestData(`/api/rosters/${plan.id}/sync`, {}, job => jobBanner(syncProgress, job), current);
      if (!current()) return;
      upsert(updated);
      paintPlans();
      paintHeader();
      await load(true);
      if (current() && !quiet) toast('已按最新群成员名单核对', 'ok');
    } catch (error) {
      if (current()) {
        plan.last_error = error.message;
        paintHeader();
        if (!quiet) toast(error.message, 'err', error.hint);
      }
    } finally {
      syncing = false;
      if (current()) { syncProgress.hidden = true; selection(); arm(); }
    }
  }
  async function loadPlans(id = activeId) {
    plansLoading = true;
    selection();
    try {
      const result = await api.get('/api/rosters');
      if (!root.isConnected) return;
      plans = result.rosters;
      const next = plans.some(plan => plan.id === id) ? id : plans[0]?.id || '';
      if (activeId !== next) { activeId = next; resetCriteria(); }
      save();
      paintPlans();
      paintHeader();
      paintStatus();
      await load();
      arm();
    } catch (error) {
      if (!root.isConnected) return;
      planHost.innerHTML = `${errorBox(error)}<button class="btn btn-sm" type="button">重试读取计划</button>`;
      planHost.querySelector('button').addEventListener('click', () => loadPlans(id), { once: true });
    } finally {
      plansLoading = false;
      selection();
    }
  }
  planHost.addEventListener('click', async event => {
    const id = event.target.closest('[data-roster]')?.dataset.roster;
    if (!id || syncing || plansLoading || activeId === id) return;
    activeId = id;
    resetCriteria();
    save();
    paintPlans();
    paintHeader();
    paintStatus();
    await load();
    arm();
  });
  root.querySelector('#roster-new').addEventListener('click', () => importRoster(async plan => {
    if (root.isConnected) await loadPlans(plan.id);
  }));
  root.querySelector('#roster-bind').addEventListener('click', () => bindRoster(active(), async plan => {
    if (!root.isConnected) return;
    upsert(plan);
    paintPlans();
    if (activeId === plan.id) { paintHeader(); await load(); arm(); }
  }));
  root.querySelector('#roster-sync').addEventListener('click', () => sync());
  async function watchInvite(id, rosterId) {
    watchedJob = id;
    const current = () => root.isConnected && activeId === rosterId && watchedJob === id;
    try {
      const done = await api.pollJob(id, job => jobBanner(jobProgress, job), undefined, current);
      if (done && current()) await load();
    } catch (error) {
      if (current() && error.code !== 'APP_ERROR') toast(error.message, 'err', error.hint);
    }
  }
  root.querySelector('#roster-resend').addEventListener('click', async () => {
    const plan = active();
    if (!plan?.invitation) return;
    try {
      const ids = await actions.resolveIds(list);
      if (!root.isConnected || activeId !== plan.id || !ids?.length) return;
      openMemberAction('invite', { group: { id: plan.group_id, name: plan.group_name },
        spec: { tracking_id: plan.id, selected: ids } }, result => watchInvite(result.job.id, plan.id));
    } catch (error) { if (root.isConnected) toast(error.message, 'err', error.hint); }
  });
  root.querySelector('#roster-auto').addEventListener('change', event => { automatic = event.target.checked; save(); arm(); });
  root.querySelector('#roster-delete').addEventListener('click', async () => {
    const plan = active();
    if (!plan || !await confirmAction({ title: '删除本地建群计划', message: `删除“${plan.name}”的名单及其入群记录？`, confirmText: '删除计划', danger: true })) return;
    try { await api.del(`/api/rosters/${plan.id}`); clear(); await loadPlans(); toast('本地建群计划已删除', 'ok'); }
    catch (error) { toast(error.message, 'err', error.hint); }
  });
  disposeView = () => { clearTimeout(timer); query.dispose(); list?.destroy(); };
  loadPlans().then(() => {
    if (!root.isConnected) return;
    if (params.get('job') && activeId === params.get('plan')) watchInvite(params.get('job'), activeId);
    if (automatic && active()?.group_id && Date.now() / 1000 - (active().checked_at || 0) >= 30) sync(true);
  });
}

export function dispose() { disposeView?.(); disposeView = null; }
