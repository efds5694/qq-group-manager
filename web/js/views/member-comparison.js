import { state } from '../state.js';
import { esc, toast, fmtNumber, actionMenu } from '../ui.js';
import { FilterBar, emptyRule, clone } from '../filters.js';
import { chooseGroups, requestData, ResultQuery, showDetails, scopeContext, names, scopeCard } from '../workspace.js';
import { ResultTable, dataColumns, readResultIds, retainSelection } from '../result-table.js';
import { mountChoices, mountQueryBar } from '../search-controls.js';
import { mountResultActions } from '../result-controls.js';
import { groupTag, observeGroupTrays, paintGroupTrays } from '../field-display.js';

const STATUS = [['missing', '缺少'], ['outside', '名单外'], ['common', '共有'], ['all', '全部']];

export function mountComparison(container, cfg, save) {
  let data, list;
  const selected = new Set();
  cfg.rule ||= emptyRule();
  cfg.saved ||= [];
  cfg.status ||= 'missing';
  container.innerHTML = `<div class="member-comparison-task">
    <div class="task-scope-grid" id="compare-scopes"></div>
    <div class="comparison-config-bar">${actionMenu('核对配置', '<select class="input" id="compare-saved" aria-label="已保存的核对配置"></select><button class="btn btn-sm" id="compare-save-toggle" data-menu-keep>保存核对配置</button><button class="btn btn-sm btn-text" id="compare-delete">删除已选配置</button><div id="compare-save-form" hidden><input class="input" id="compare-config-name" placeholder="配置名称" aria-label="核对配置名称"/><button class="btn btn-sm" id="compare-save">另存配置</button></div>')}<span id="compare-expected" class="tiny muted"></span></div>
    <div class="comparison-layout"><aside id="compare-targets" class="comparison-targets" aria-label="逐群核对摘要"></aside>
      <section class="workspace-card comparison-results"><div class="comparison-result-head"><h3 id="compare-active-name">选择待核对群</h3></div>
      <div id="compare-query"></div><div id="compare-actions"></div>
      <div id="compare-progress" hidden></div><div id="compare-operation" hidden></div><div id="compare-results"></div></section></div>
  </div>`;
  const root = container.querySelector('.member-comparison-task');
  const host = root.querySelector('#compare-results');
  const scopeHost = root.querySelector('#compare-scopes');
  const targetHost = root.querySelector('#compare-targets');
  const targetName = root.querySelector('#compare-active-name');
  const expected = root.querySelector('#compare-expected');
  const query = new ResultQuery(root.querySelector('#compare-progress'), {
    isActive: () => root.isConnected,
    onChange() { list?.setLoading(!query.ready); selection(); },
  });
  const actions = mountResultActions(root.querySelector('#compare-actions'), {
    selected, progress: root.querySelector('#compare-operation'), onClear: clear,
  });
  const bar = mountQueryBar(root.querySelector('#compare-query'), {
    search: { label: '搜索核对结果', placeholder: '搜索 QQ号、昵称或群昵称', value: cfg.search || '',
      onSubmit(value) { cfg.search = value; clear(); load(); } },
    tools: '<div id="compare-status"></div>',
  });
  const status = mountChoices(root.querySelector('#compare-status'), {
    label: '核对结果状态', onChange(value) { cfg.status = value; clear(); load(); },
  });
  status.setChoices(STATUS, cfg.status);
  function selection() {
    if (!root.isConnected) return;
    actions.update({ data, ready: query.ready, busy: query.loading || Boolean(list?.selectionBusy), unit: '人' });
  }
  function clear() {
    selected.clear();
    actions.resetRange();
    list?.schedule();
    selection();
  }
  const saved = root.querySelector('#compare-saved');
  const paintSaved = () => {
    saved.innerHTML = '<option value="">选择已保存的核对配置</option>' + cfg.saved.map(item =>
      `<option value="${esc(item.id)}"${item.id === cfg.savedId ? ' selected' : ''}>${esc(item.name)}</option>`).join('');
  };
  function paintScopes() {
    scopeHost.innerHTML = scopeCard('名单来源群', cfg.sourceIds, 'compare-pick-source', '来源群中符合条件的人，按 QQ 号合并为应到名单。') +
      scopeCard('待核对群', cfg.targetIds, 'compare-pick-target');
    scopeHost.firstElementChild.insertAdjacentHTML('beforeend', '<div class="scope-filter" id="compare-source-filter"></div>');
    new FilterBar(root.querySelector('#compare-source-filter'), {
      menu: true, label: '来源成员条件', rule: cfg.rule, context: 'comparison',
      onApply(rule) { cfg.rule = rule; clear(); load(); },
    });
    paintGroupTrays(scopeHost);
    root.querySelector('#compare-pick-source').addEventListener('click', () => chooseGroups({
      title: '选择名单来源群', selected: cfg.sourceIds, onApply(ids) { cfg.sourceIds = ids; clear(); paintScopes(); load(); },
    }));
    root.querySelector('#compare-pick-target').addEventListener('click', () => chooseGroups({
      title: '选择待核对群', selected: cfg.targetIds,
      onApply(ids) { cfg.targetIds = ids; cfg.activeTarget = ids[0] || ''; clear(); paintScopes(); load(); },
    }));
  }
  function paintTargets() {
    targetHost.innerHTML = data.summaries.map(group => {
      const active = group.group_id === data.target_group_id;
      return `<button class="comparison-target${active ? ' active' : ''}" data-target="${esc(group.group_id)}" aria-pressed="${active}">
        <strong>${groupTag(group.name, group.group_id)}</strong><span>应到 ${fmtNumber(group.expected)} · 群内 ${fmtNumber(group.actual)}</span>
        <small>缺少 ${fmtNumber(group.missing)} · 名单外 ${fmtNumber(group.outside)} · 共有 ${fmtNumber(group.common)}</small></button>`;
    }).join('');
  }
  targetHost.addEventListener('click', event => {
    const target = event.target.closest('[data-target]')?.dataset.target;
    if (!target || cfg.activeTarget === target || !cfg.targetIds.includes(target)) return;
    cfg.activeTarget = target;
    clear(); load();
  });

  function load(force = false) {
    if (!root.isConnected) return;
    if (!cfg.targetIds.includes(cfg.activeTarget)) cfg.activeTarget = cfg.targetIds[0];
    save();
    if (!cfg.sourceIds.length || !cfg.targetIds.length) {
      list?.destroy();
      data = list = null;
      host.innerHTML = '<div class="empty"><strong>选择名单来源群和待核对群</strong></div>';
      targetHost.innerHTML = expected.textContent = '';
      targetName.textContent = '核对结果';
      query.reset();
      return;
    }
    const scope = scopeContext([...cfg.sourceIds, ...cfg.targetIds]);
    const request = {
      source_group_ids: cfg.sourceIds, target_group_ids: cfg.targetIds, source_filter: cfg.rule,
      target_group_id: cfg.activeTarget, status: cfg.status, search: cfg.search || '', show_remark: scope.show_remark, refresh: force,
    };
    return query.run(async (report, current) => {
      const response = await requestData('/api/members/compare', request, report, current);
      if (!current()) return;
      const selectionIds = selected.size ? await readResultIds(response) : null;
      return { response, selectionIds };
    }, ({ response, selectionIds }) => {
      if (selectionIds) retainSelection(selected, selectionIds);
      data = selectionIds ? { ...response, selection_ids: selectionIds } : response;
      list?.destroy();
      list = new ResultTable(host, {
        selected, sort: { field: 'member.qq', desc: false }, layoutKey: 'comparison', onSelection: selection, onReload: () => load(),
        onDetail: row => { if (query.ready) showDetails({ scope }, row, row.detail_group_id); },
      });
      list.setData(data, dataColumns(data, { selected, search: request.search }));
      expected.textContent = `应到名单 ${fmtNumber(data.expected)} 人`;
      targetName.textContent = names([data.target_group_id])[0];
      paintTargets();
    }, () => load(force));
  }
  const form = root.querySelector('#compare-save-form');
  root.querySelector('#compare-save-toggle').addEventListener('click', () => { form.hidden = !form.hidden; });
  root.querySelector('#compare-save').addEventListener('click', () => {
    const name = root.querySelector('#compare-config-name').value.trim();
    if (!name) { toast('请填写配置名称', 'warn'); return; }
    const item = { id: crypto.randomUUID(), name, sourceIds: [...cfg.sourceIds], targetIds: [...cfg.targetIds], rule: clone(cfg.rule) };
    cfg.saved.push(item);
    cfg.savedId = item.id;
    save(); paintSaved(); form.hidden = true;
    toast('核对配置已保存到当前账号的浏览器', 'ok');
  });
  saved.addEventListener('change', () => {
    cfg.savedId = saved.value;
    const item = cfg.saved.find(entry => entry.id === cfg.savedId);
    if (!item) { save(); return; }
    const available = new Set(state.groups.map(group => group.group_id));
    cfg.sourceIds = item.sourceIds.filter(id => available.has(id));
    cfg.targetIds = item.targetIds.filter(id => available.has(id));
    cfg.rule = clone(item.rule);
    cfg.status = 'missing';
    cfg.search = '';
    cfg.activeTarget = cfg.targetIds[0];
    bar.search.setValue('');
    status.setValue(cfg.status);
    clear(); paintScopes(); load();
  });
  root.querySelector('#compare-delete').addEventListener('click', () => {
    if (!cfg.savedId) return;
    cfg.saved = cfg.saved.filter(item => item.id !== cfg.savedId);
    cfg.savedId = '';
    save(); paintSaved(); toast('已删除核对配置', 'ok');
  });
  const stopWatching = observeGroupTrays(scopeHost);
  paintScopes();
  paintSaved();
  load();
  return {
    dispose() { query.dispose(); stopWatching(); list?.destroy(); },
    refresh: () => load(true),
  };
}
