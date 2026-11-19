import { state, loadPrefs, savePrefs } from '../state.js';
import { esc, fmtNumber, actionMenu } from '../ui.js';
import { catalog, emptyRule, fieldSelectOptions, clone } from '../filters.js';
import { initialize, requestData, jobBanner, ResultQuery, scopeContext, showDetails, showPersonDetails, chooseColumns,
  chooseGroups, collect, defaultSources, names, scopeCard, workspaceTabs } from '../workspace.js';
import { openRename } from '../actions.js';
import { openRosterMatch, openMemberAction } from '../member-actions.js';
import { navigate } from '../router.js';
import * as api from '../api.js';
import { ResultTable, dataColumns, readResultIds, retainSelection } from '../result-table.js';
import { MEMBER_SEARCH, mountChoices, mountQueryBar } from '../search-controls.js';
import { mountDisplayOptions, mountResultActions } from '../result-controls.js';
import { mountComparison } from './member-comparison.js';
import { groupTag, observeGroupTrays, paintGroupTrays } from '../field-display.js';

let controller;
const OVERVIEW_FIELDS = ['member.qq','member.nickname','person.group_count','person.group_names'];
const DETAIL_FIELDS = ['member.qq','member.nickname','group.display_name','member.card','member.role','member.level','member.join_time','member.last_sent_time','member.title'];
const RENAME_FIELDS = ['member.qq','member.nickname','person.reference_text','person.source_group_name','member.card','person.source_conflict','group.display_name'];
const LAYOUTS = [['people', '按人汇总'], ['memberships', '群内明细'], ['matrix', '逐群对照']];
const NICKNAME_FILTERS = [['all', '全部'], ['different', '昵称不同'], ['empty', '无来源文本'], ['conflict', '来源冲突']];
const NICKNAME_RULES = {
  different: { field: 'person.nickname_difference', op: 'eq', value: true },
  conflict: { field: 'person.source_conflict', op: 'eq', value: true },
  empty: { field: 'person.reference_text', op: 'empty' },
};

function migrate(old, available) {
  const valid = ids => (ids || []).filter(id => available.has(id));
  const groups = valid(old.groupIds || (state.group ? [state.group.group_id] : defaultSources()));
  const source = valid(old.sources ?? defaultSources());
  const sourceRule = JSON.stringify(old.rule || {}).match(/person\.(reference_card|source_group_id|source_conflict|nickname_difference)/);
  return { overview: { groupIds: groups, view: 'people', rule: sourceRule ? emptyRule() : old.rule || emptyRule(),
      columns: OVERVIEW_FIELDS, detailColumns: old.columns || DETAIL_FIELDS, search: old.search || '', groupBy: old.groupBy || {} },
    comparison: { sourceIds: source, targetIds: groups.filter(id => !source.includes(id)), rule: emptyRule(), status: 'missing', saved: [] },
    rename: { sourceIds: source, targetIds: groups.filter(id => !source.includes(id)), rule: sourceRule ? old.rule : emptyRule(), method: 'sync', sourceField: 'member.card' } };
}

export async function render(container, route = 'members') {
  await initialize(container);
  const account = state.session?.login?.user_id || 'local';
  const key = `member-tasks.${account}`;
  const allPrefs = loadPrefs();
  const available = new Set(state.groups.map(group => group.group_id));
  const prefs = clone(allPrefs[key] || migrate(allPrefs[`workbench.${account}`] || {}, available));
  for (const cfg of [prefs.overview, prefs.comparison, prefs.rename]) {
    for (const prop of ['groupIds', 'sourceIds', 'targetIds']) if (cfg[prop]) cfg[prop] = cfg[prop].filter(id => available.has(id));
  }
  if (route === 'members') {
    const incoming = state.workbenchGroups ?? state.crossGroupTargets;
    if (incoming) prefs.overview.groupIds = incoming.filter(id => available.has(id));
    if (state.workbenchMode) {
      prefs.overview.view = state.workbenchMode;
      if (incoming && state.workbenchMode === 'memberships') {
        prefs.overview.rule = emptyRule();
        prefs.overview.search = '';
        prefs.overview.groupBy = {};
      }
    }
    state.workbenchGroups = state.crossGroupTargets = state.workbenchMode = null;
  }
  const save = () => savePrefs({ [key]: prefs });
  const comparison = route === 'lists/compare', rename = route === 'members/rename';
  const section = comparison ? 'lists' : 'members';
  const title = comparison ? '群关系核对' : rename ? '改群昵称' : '人员总览';
  container.innerHTML = `<div class="page members-workspace"><div class="page-head">${workspaceTabs(section, route)}<button class="btn" data-refresh-view>刷新</button></div><div id="member-task-body"></div></div>`;
  const target = container.querySelector('#member-task-body');
  target.setAttribute('aria-label', title);
  controller = comparison ? mountComparison(target, prefs.comparison, save) : mountList(target, rename ? prefs.rename : prefs.overview, save, rename);
}

function mountList(container, cfg, save, renameTask) {
  let data, list, matched = null, project = null;
  const selected = new Set();
  cfg.view ||= 'people';
  cfg.method ||= 'sync';
  cfg.rule ||= emptyRule();
  cfg.groupBy ||= {};
  cfg.sort ||= { field: 'member.qq', desc: false };
  const sync = () => renameTask && cfg.method === 'sync';
  const ids = () => renameTask ? cfg.targetIds : cfg.groupIds;
  const sources = () => sync() ? cfg.sourceIds : [];
  const matrix = () => !renameTask && cfg.view === 'matrix';
  const entity = () => !renameTask && cfg.view !== 'memberships' ? 'people' : 'memberships';
  const fields = () => {
    if (renameTask) return sync() ? cfg.syncColumns || RENAME_FIELDS : cfg.otherColumns || DETAIL_FIELDS;
    return cfg.view === 'memberships' ? cfg.detailColumns || DETAIL_FIELDS : cfg.columns || OVERVIEW_FIELDS;
  };
  const spec = () => {
    const quick = sync() && NICKNAME_RULES[cfg.quick];
    const filter = quick ? { op: 'and', rules: [cfg.rule, quick] } : cfg.rule;
    return {
      entity: entity(), scope: scopeContext(ids(), sources()), filter: matched ? emptyRule() : filter,
      fields: fields(), search: matched ? '' : cfg.search || '', sort: cfg.sort, group_by: cfg.groupBy,
      matrix: matrix(), matrix_field: cfg.matrixField || 'member.card',
      roster_qqs: matched ? [...matched] : undefined, project_selection: matched ? [...matched] : project ?? undefined,
      source_field: cfg.sourceField || 'member.card',
    };
  };
  const renameOptions = `<div class="rename-method-bar"><label>生成方式 <select class="input" id="task-method"><option value="sync">从来源群同步</option><option value="template">按变量模板</option><option value="mapping">按 CSV 名单</option></select></label>
    <label id="task-source-field-label">读取字段 <select class="input" id="task-source-field">${fieldSelectOptions(cfg.sourceField || 'member.card')}</select></label></div>`;
  container.innerHTML = `<div class="member-list-task">${renameTask ? renameOptions : ''}<div id="task-scopes"${renameTask ? ' class="task-scope-grid"' : ''}></div>
    <section class="workspace-card"><div id="task-query"></div><div id="task-actions"></div>
      <div id="task-progress" hidden></div><div id="task-operation" hidden></div><div id="task-results"></div>
    </section></div>`;
  const root = container.querySelector('.member-list-task');
  const host = root.querySelector('#task-results');
  const progress = root.querySelector('#task-operation');
  const scopeHost = root.querySelector('#task-scopes');
  const accounts = () => [...new Set([...selected].map(id => id.split(':').at(-1)))];
  const query = new ResultQuery(root.querySelector('#task-progress'), {
    isActive: () => root.isConnected,
    onChange() { list?.setLoading(!query.ready); selection(); },
  });
  const bar = mountQueryBar(root.querySelector('#task-query'), {
    search: { label: '搜索成员', placeholder: MEMBER_SEARCH, value: cfg.search || '', onSubmit(value) { cfg.search = value; clear(); load(); } },
    filter: { rule: cfg.rule, context: renameTask ? 'rename' : 'overview', onApply(rule) { cfg.rule = rule; clear(); load(); } },
    tools: `<div id="task-display"></div><div id="task-view-options"></div>${renameTask ? '' : '<button class="btn btn-sm" id="task-restore" hidden>恢复原筛选</button>'}`,
  });
  const display = mountDisplayOptions(root.querySelector('#task-display'), {
    groupBy: cfg.groupBy,
    chooseColumns: () => chooseColumns(fields(), value => {
      if (renameTask) cfg[sync() ? 'syncColumns' : 'otherColumns'] = value;
      else cfg[cfg.view === 'memberships' ? 'detailColumns' : 'columns'] = value;
      load();
    }, entity()),
    onGroup(value) { cfg.groupBy = value; load(); },
    extra: renameTask ? '' : `<label id="task-matrix-label" hidden>单元格字段<select class="input" id="task-matrix">${catalog.fields.filter(field => field.id.startsWith('member.')).map(field => `<option value="${esc(field.id)}">${esc(field.label)}</option>`).join('')}</select></label>`,
  });
  const viewHost = root.querySelector('#task-view-options');
  const choices = mountChoices(viewHost, {
    label: renameTask ? '昵称状态' : '人员显示方式',
    onChange(value) {
      if (renameTask) { cfg.quick = value; clear(); }
      else { project = accounts(); cfg.view = value; }
      load();
    },
  });
  choices.setChoices(renameTask ? NICKNAME_FILTERS : LAYOUTS, renameTask ? cfg.quick || 'all' : cfg.view);
  const actionButtons = renameTask
    ? '<button class="btn btn-sm btn-primary" id="task-rename">预演并改名</button>'
    : `<button class="btn btn-sm" id="task-match">按名单勾选</button><button class="btn btn-sm" data-member-action="invite">发起邀请</button>
      ${actionMenu('成员管理', '<button class="btn btn-sm" data-member-action="ban">禁言</button><button class="btn btn-sm btn-danger" data-member-action="kick">移出成员</button>')}`;
  const actions = mountResultActions(root.querySelector('#task-actions'), {
    selected, onClear() { const reload = Boolean(matched); clear(); if (reload) load(); }, progress,
    tools: `${actionButtons}${actionMenu('更多', '<button class="btn btn-sm" id="task-collect">补全本次范围资料</button><button class="btn btn-sm" id="task-retry">重试采集失败项</button>')}`,
  });
  function selection() {
    if (!root.isConnected) return;
    const busy = query.loading || Boolean(list?.selectionBusy);
    actions.update({
      data, ready: query.ready, busy, locked: Boolean(matched), unit: entity() === 'people' ? '人' : '条群记录',
      label: data && `${matched ? '仅看勾选 · ' : ''}${fmtNumber(data.people)} 人 · ${fmtNumber(data.memberships)} 条群记录`,
    });
    const rename = root.querySelector('#task-rename');
    if (rename) rename.disabled = !actions.usable();
    for (const button of root.querySelectorAll('[data-member-action]')) button.disabled = !actions.usable() || !selected.size;
    if (!renameTask) {
      root.querySelector('#task-match').disabled = busy || !ids().length;
      root.querySelector('#task-restore').hidden = !matched;
      bar.setSuspended(Boolean(matched));
    }
    for (const id of ['task-collect', 'task-retry']) root.querySelector('#' + id).disabled = busy || !ids().length || (sync() && !sources().length);
  }
  function clear() {
    selected.clear();
    matched = project = null;
    actions.resetRange();
    selection();
    list?.schedule();
  }
  function selectionChanged(change) {
    if (matched && !list?.selectionBusy && query.ready) {
      if (change && !change.checked) {
        const qq = change.id.split(':').at(-1);
        for (const id of selected) if (id.split(':').at(-1) === qq) selected.delete(id);
      }
      const next = new Set(accounts());
      if (next.size !== matched.size) {
        matched = next.size ? next : null;
        load();
        return;
      }
    }
    selection();
  }

  function paintScopes() {
    scopeHost.innerHTML = renameTask
      ? `${sync() ? scopeCard('读取昵称的来源群', cfg.sourceIds, 'task-pick-source', '从上到下采用第一个非空值。') : ''}${scopeCard('准备修改的目标群', cfg.targetIds, 'task-pick-target')}`
      : scopeCard('查看哪些群的成员', cfg.groupIds, 'task-pick-target', '所在群数和群关系仅统计本次查看范围。');
    root.querySelector('#task-pick-target').addEventListener('click', () => chooseGroups({
      title: renameTask ? '选择准备修改的目标群' : '选择查看范围', selected: ids(), excluded: sources(),
      onApply(value) { cfg[renameTask ? 'targetIds' : 'groupIds'] = value; clear(); paintScopes(); load(); },
    }));
    if (renameTask) {
      root.querySelector('#task-source-field-label').hidden = !sync();
      viewHost.hidden = !sync();
    }
    if (sync()) {
      scopeHost.querySelector('.task-scope-card').insertAdjacentHTML('beforeend', `<details class="priority-editor"><summary>调整来源优先级</summary>${cfg.sourceIds.map((gid, index) =>
        `<div class="source-order-row"><span>${index + 1}</span><strong>${groupTag(names([gid])[0], gid)}</strong><button class="icon-btn" data-move-source="${index}" data-step="-1" ${index ? '' : 'disabled'} aria-label="提高优先级">↑</button><button class="icon-btn" data-move-source="${index}" data-step="1" ${index < cfg.sourceIds.length - 1 ? '' : 'disabled'} aria-label="降低优先级">↓</button></div>`).join('')}<button class="btn btn-sm btn-text" id="task-default-source">默认【师生】群</button></details>`);
      const setSource = value => {
        cfg.sourceIds = value;
        cfg.targetIds = cfg.targetIds.filter(id => !value.includes(id));
        clear(); paintScopes(); load();
      };
      scopeHost.querySelectorAll('[data-move-source]').forEach(button => button.addEventListener('click', () => {
        const i = Number(button.dataset.moveSource), j = i + Number(button.dataset.step);
        [cfg.sourceIds[i], cfg.sourceIds[j]] = [cfg.sourceIds[j], cfg.sourceIds[i]];
        clear(); paintScopes(); load();
      }));
      root.querySelector('#task-pick-source').addEventListener('click', () => chooseGroups({ title: '选择读取昵称的来源群', selected: cfg.sourceIds, onApply: setSource }));
      root.querySelector('#task-default-source').addEventListener('click', () => setSource(defaultSources()));
    }
    paintGroupTrays(scopeHost);
  }

  function load(force = false) {
    if (!root.isConnected) return;
    save();
    const matrixLabel = root.querySelector('#task-matrix-label');
    if (matrixLabel) matrixLabel.hidden = !matrix();
    display.setColumnsVisible(!matrix());
    if (!ids().length || sync() && !sources().length) {
      list?.destroy();
      list = data = null;
      const title = sync() && !sources().length ? '选择读取昵称的来源群' : renameTask ? '选择准备修改的目标群' : '选择要查看的群';
      host.innerHTML = `<div class="empty"><strong>${title}</strong></div>`;
      query.reset();
      return;
    }
    const request = spec();
    return query.run(async (report, current) => {
      const response = await requestData('/api/query/start', { ...request, refresh: force }, report, current);
      if (!current()) return;
      const selectionIds = selected.size && !response.projected_selection ? await readResultIds(response) : null;
      return { response, selectionIds };
    }, ({ response, selectionIds }) => {
      if (response.projected_selection) {
        selected.clear();
        response.projected_selection.forEach(id => selected.add(id));
      } else if (selectionIds) retainSelection(selected, selectionIds);
      project = null;
      data = selectionIds ? { ...response, selection_ids: selectionIds } : response;
      list?.destroy();
      list = new ResultTable(host, {
        selected, sort: cfg.sort, layoutKey: renameTask ? `rename:${sync() ? 'sync' : 'other'}` : `members:${cfg.view}`,
        rowHeight: matrix() ? 60 : 48, onSelection: selectionChanged, onReload: () => load(),
        onSort: field => { cfg.sort = { field, desc: cfg.sort.field === field ? !cfg.sort.desc : false }; load(); },
        onDetail(row, gid) {
          if (!query.ready) return;
          if (request.entity === 'people') showPersonDetails(request, row, gid);
          else showDetails(request, row, gid);
        },
      });
      list.setData(data, dataColumns(data, {
        selected, matrix: matrix(), matrixField: request.matrix_field, overview: !renameTask && cfg.view === 'people', navigateGroups: true, search: request.search,
      }));
    }, () => load(force));
  }

  root.querySelector('#task-collect').addEventListener('click', () => collect([...new Set([...ids(), ...sources()])], progress, false, () => load()));
  root.querySelector('#task-retry').addEventListener('click', () => collect([...new Set([...ids(), ...sources()])], progress, true, () => load()));
  if (renameTask) {
    const method = root.querySelector('#task-method'), sourceField = root.querySelector('#task-source-field');
    method.value = cfg.method;
    sourceField.value = cfg.sourceField || 'member.card';
    method.addEventListener('change', () => {
      cfg.method = method.value;
      if (sync()) cfg.targetIds = cfg.targetIds.filter(id => !cfg.sourceIds.includes(id));
      clear(); paintScopes(); load();
    });
    sourceField.addEventListener('change', () => { cfg.sourceField = sourceField.value; clear(); load(); });
    root.querySelector('#task-rename').addEventListener('click', () =>
      openRename({ ...spec(), selected: actions.selectedIds() }, progress, () => { clear(); load(true); }, { method: cfg.method, source_field: cfg.sourceField }));
  } else {
    const matrixField = root.querySelector('#task-matrix');
    matrixField.value = cfg.matrixField || 'member.card';
    matrixField.addEventListener('change', () => { cfg.matrixField = matrixField.value; load(); });
    root.querySelector('#task-match').addEventListener('click', () => openRosterMatch([...ids()], async result => {
      if (!root.isConnected || ids().join(',') !== result.source_ids.join(',')) return;
      selected.clear();
      matched = new Set(result.qqs);
      actions.resetRange();
      await load();
    }));
    root.querySelector('#task-restore').addEventListener('click', () => { project = accounts(); matched = null; load(); });
    root.querySelectorAll('[data-member-action]').forEach(button => button.addEventListener('click', () => {
      openMemberAction(button.dataset.memberAction, { sourceIds: [...ids()], spec: { query_id: data.query_id, selected: [...selected] } },
        async result => {
          if (!root.isConnected) return;
          if (result.tracking_id) {
            const params = { plan: result.tracking_id };
            if (result.job) params.job = result.job.id;
            navigate('lists', params);
            return;
          }
          const done = await api.pollJob(result.job.id, job => jobBanner(progress, job), undefined, () => root.isConnected);
          if (done && root.isConnected) { project = accounts(); await load(true); }
        });
    }));
  }
  const stopWatching = observeGroupTrays(scopeHost);
  paintScopes();
  load();
  return {
    dispose() { query.dispose(); stopWatching(); list?.destroy(); },
    refresh() { project = accounts(); return load(true); },
  };
}

export async function refresh() { await controller?.refresh(); }
export function dispose() { controller?.dispose(); controller = null; }
