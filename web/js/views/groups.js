import { state, loadPrefs, savePrefs } from '../state.js';
import { navigate, routeParams } from '../router.js';
import * as api from '../api.js';
import { toast, actionMenu } from '../ui.js';
import { catalog, emptyRule } from '../filters.js';
import { initialize, requestData, ResultQuery, scopeContext, showDetails, chooseColumns, collect } from '../workspace.js';
import { openGroupSettings } from '../actions.js';
import { ResultTable, dataColumns, readResultIds, retainSelection } from '../result-table.js';
import { GROUP_SEARCH, mountQueryBar } from '../search-controls.js';
import { mountDisplayOptions, mountResultActions } from '../result-controls.js';

let controller;

export async function render(container) {
  await initialize(container);
  const key = `catalog.${state.session?.login?.user_id || 'local'}`;
  const prefs = loadPrefs()[key] || {};
  let rule = prefs.rule || emptyRule();
  let columns = prefs.columns || catalog.group_columns;
  let sort = prefs.sort || { field: 'group.display_name', desc: false };
  let groupBy = prefs.groupBy || {};
  let search = prefs.search || '';
  let data, list;
  const selected = new Set();
  let pendingFocus = routeParams().get('focus') || '', temporaryFocus = '';
  container.innerHTML = `<div class="page directory-page"><div class="page-head"><h1>群聊目录</h1><button class="btn" data-refresh-view>刷新</button></div>
    <section class="workspace-card"><div id="directory-query"></div><div id="directory-actions"></div>
    <div id="directory-progress" hidden></div><div id="directory-operation" hidden></div><div id="directory-table"></div></section></div>`;
  const root = container.querySelector('.directory-page');
  const table = root.querySelector('#directory-table');
  const progress = root.querySelector('#directory-operation');
  const spec = (focus = temporaryFocus) => ({
    entity: 'groups', scope: scopeContext([]), fields: columns, sort, group_by: groupBy,
    filter: focus ? { field: 'group.group_id', op: 'eq', value: focus } : rule, search: focus ? '' : search,
  });
  const save = () => savePrefs({ [key]: { rule, columns, sort, groupBy, search } });
  const clear = () => { selected.clear(); actions.resetRange(); list?.schedule(); selection(); };
  const query = new ResultQuery(root.querySelector('#directory-progress'), {
    isActive: () => root.isConnected,
    onChange() { list?.setLoading(!query.ready); selection(); },
  });
  const bar = mountQueryBar(root.querySelector('#directory-query'), {
    search: { label: '搜索群聊', placeholder: GROUP_SEARCH, value: search, onSubmit(value) { search = value; clear(); load(); } },
    filter: { rule, entity: 'groups', onApply(value) { rule = value; clear(); load(); } },
    tools: '<div id="directory-display"></div><span class="tiny muted" id="directory-focus" hidden>定位群聊</span><button class="btn btn-sm" id="directory-restore" hidden>恢复原筛选</button>',
  });
  mountDisplayOptions(root.querySelector('#directory-display'), {
    groupBy, chooseColumns: () => chooseColumns(columns, value => { columns = value; load(); }, 'groups'),
    onGroup(value) { groupBy = value; load(); },
  });
  const actions = mountResultActions(root.querySelector('#directory-actions'), {
    selected, progress, onClear: clear,
    tools: `<button class="btn btn-sm btn-primary" id="directory-open">查看成员</button>
      <button class="btn btn-sm" id="directory-settings" data-directory-selected>群设置</button>
      ${actionMenu('更多', '<button class="btn btn-sm" id="directory-favorite" data-directory-selected>收藏／取消收藏</button><button class="btn btn-sm" id="directory-collect" data-directory-selected>补全所选群资料</button><button class="btn btn-sm" id="directory-retry" data-directory-selected>重试采集失败项</button>')}`,
  });
  function selection() {
    if (!root.isConnected) return;
    const busy = query.loading || Boolean(list?.selectionBusy);
    actions.update({ data, ready: query.ready, busy, unit: '个群' });
    root.querySelector('#directory-open').disabled = !actions.usable();
    for (const button of root.querySelectorAll('[data-directory-selected]')) button.disabled = !actions.usable() || !selected.size;
    bar.setSuspended(Boolean(temporaryFocus));
    root.querySelector('#directory-focus').hidden = !temporaryFocus;
    root.querySelector('#directory-restore').hidden = !temporaryFocus;
  }
  function load(force = false) {
    if (!root.isConnected) return;
    save();
    const position = (response, id) => api.get(`/api/query/results/${response.query_id}/position`, { id });
    return query.run(async (report, current) => {
      const request = (focus, refresh) => requestData('/api/query/start', { ...spec(focus), refresh }, report, current);
      let response = await request(temporaryFocus, force);
      if (!current()) return;
      let offset = null, focus = temporaryFocus;
      const id = pendingFocus;
      if (id) {
        ({ index: offset } = await position(response, id));
        if (!current()) return;
        if (offset === null) {
          const focused = await request(id, false);
          if (!current()) return;
          ({ index: offset } = await position(focused, id));
          if (!current()) return;
          if (offset !== null) { focus = id; response = focused; }
        }
      }
      const selectionIds = selected.size ? await readResultIds(response) : null;
      return { response, offset, focus, id, selectionIds };
    }, ({ response, offset, focus, id, selectionIds }) => {
      if (selectionIds) retainSelection(selected, selectionIds);
      if (id && offset === null) toast('该群不在当前账号的群聊目录中', 'warn');
      if (id && offset !== null) selected.add(id);
      temporaryFocus = focus;
      pendingFocus = '';
      data = selectionIds ? { ...response, selection_ids: selectionIds } : response;
      list?.destroy();
      list = new ResultTable(table, {
        selected, sort, layoutKey: 'directory', onSelection: selection, onReload: () => load(),
        onSort: field => { sort = { field, desc: sort.field === field ? !sort.desc : false }; load(); },
        onRowDoubleClick(row) {
          if (!query.ready) return;
          state.workbenchGroups = [row.group_id];
          state.workbenchMode = 'memberships';
          navigate('members');
        },
        onDetail: row => { if (query.ready) showDetails(spec(), row); },
      });
      list.setData(data, dataColumns(data, { selected, search: spec().search }));
      if (offset !== null) {
        const current = list;
        requestAnimationFrame(() => {
          if (list === current && !current.disposed && query.ready) current.vertical.scrollToIndex(offset, { align: 'center' });
        });
      }
    }, () => load(force));
  }

  root.querySelector('#directory-restore').addEventListener('click', () => navigate('groups'));
  root.querySelector('#directory-open').addEventListener('click', async () => {
    try {
      const ids = await actions.resolveIds(list);
      if (!ids?.length) return;
      state.workbenchGroups = ids;
      navigate('members');
    } catch (error) { toast(error.message, 'err', error.hint); }
  });
  root.querySelector('#directory-settings').addEventListener('click', () => openGroupSettings([...selected], progress, () => load(true)));
  root.querySelector('#directory-favorite').addEventListener('click', () => {
    const favorites = new Set(loadPrefs().favoriteGroups || []);
    const remove = [...selected].every(gid => favorites.has(gid));
    selected.forEach(gid => { if (remove) favorites.delete(gid); else favorites.add(gid); });
    savePrefs({ favoriteGroups: [...favorites] });
    load();
  });
  root.querySelector('#directory-collect').addEventListener('click', () => collect([...selected], progress, false, () => load()));
  root.querySelector('#directory-retry').addEventListener('click', () => collect([...selected], progress, true, () => load()));
  controller = {
    refresh: () => load(true),
    dispose() { query.dispose(); list?.destroy(); },
  };
  load().then(() => {
    if (!root.isConnected || !state.pendingGroupSettings) return;
    state.pendingGroupSettings = false;
    if (state.group) openGroupSettings([state.group.group_id], progress, () => load(true));
  });
}

export async function refresh() { await controller?.refresh(); }
export function dispose() { controller?.dispose(); controller = null; }
