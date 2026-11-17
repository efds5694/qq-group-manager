import { state, loadPrefs, savePrefs } from '../state.js';
import { navigate } from '../router.js';
import { esc, toast, fmtNumber } from '../ui.js';
import { FilterBar, catalog, emptyRule, fieldSelectOptions } from '../filters.js';
import { initialize, requestData, jobBanner, scopeContext, showDetails, chooseColumns, exportData, collect, errorBox, allResultRows } from '../workspace.js';
import { openGroupSettings } from '../actions.js';
import { ResultTable, dataColumns } from '../result-table.js';

let reload = null;

export async function render(container) {
  await initialize();
  const key = `catalog.${state.session?.login?.user_id || 'local'}`;
  const prefs = loadPrefs()[key] || {};
  let rule = prefs.rule || emptyRule();
  let columns = prefs.columns || catalog.group_columns;
  let sort = prefs.sort || { field: 'group.display_name', desc: false };
  let groupBy = prefs.groupBy || {};
  let search = prefs.search || '';
  let data = null;
  let selected = new Set();
  let ticket = 0;
  let loading = false;
  let ready = false;
  let list;
  container.innerHTML = `<div class="page directory-page"><div class="page-head"><div><span class="eyebrow">GROUP DIRECTORY</span><h1>群聊目录</h1><p>统一查看群资料，选择群后进入成员工作台。</p></div><div class="page-actions"><button class="btn" id="directory-refresh">刷新群列表</button><button class="btn btn-primary" id="directory-open">查看成员</button></div></div>
    <section class="workspace-card"><div class="workspace-search"><input class="input" id="directory-search" placeholder="搜索群名称、群备注、群号" aria-label="搜索群聊" value="${esc(search)}"/><span class="workspace-total" id="directory-total">读取中</span></div><div id="directory-filter" class="shared-filter"></div>
    <div class="workspace-toolbar"><span id="directory-selection" class="tiny muted"></span><button class="btn btn-sm btn-text" id="directory-clear">取消选择</button><span class="spacer"></span><button class="btn btn-sm" id="directory-columns">字段</button><details class="display-options"><summary class="btn btn-sm">分组</summary><div><label>分组字段<select class="input" id="directory-group-field"><option value="">不分组</option>${fieldSelectOptions(groupBy.field)}</select></label><label>提取分组的正则（可选）<input class="input mono" id="directory-group-pattern" value="${esc(groupBy.pattern || '')}" placeholder="^【(.+?)】"/></label><button class="btn btn-sm" id="directory-group-apply">应用分组</button></div></details>
      <button class="btn btn-sm" id="directory-copy">复制表格</button><select class="input format-select" id="directory-format" aria-label="导出格式">${(state.config?.formats || ['csv']).map(format => `<option>${format}</option>`).join('')}</select><button class="btn btn-sm" id="directory-export">导出</button><button class="btn btn-sm" id="directory-settings">群设置</button><button class="btn btn-sm" id="directory-favorite">收藏／取消收藏</button></div>
    <div id="directory-progress" hidden></div><div class="table-wrap workspace-table" id="directory-table"></div></section>
    <div class="workspace-secondary-actions"><button class="btn btn-text btn-sm" id="directory-collect">补全所选群资料</button><button class="btn btn-text btn-sm" id="directory-retry">重试采集失败项</button><span class="tiny faint">预设与成员工作台共享；各视图分别记住当前条件。</span></div></div>`;
  const root = container.querySelector('.directory-page');
  const table = root.querySelector('#directory-table');
  const progress = root.querySelector('#directory-progress');
  const spec = () => ({ entity: 'groups', scope: scopeContext([]), filter: rule, fields: columns, sort, search, group_by: groupBy });
  const save = () => savePrefs({ [key]: { rule, columns, sort, groupBy, search } });
  const selection = () => {
    if (!root.isConnected) return;
    root.querySelector('#directory-selection').textContent = selected.size ? `已选 ${selected.size} 个群` : '未勾选时，查看成员、复制和导出使用当前全部筛选结果';
    root.querySelector('#directory-clear').disabled = !selected.size;
    for (const id of ['directory-settings', 'directory-favorite', 'directory-collect', 'directory-retry']) root.querySelector(`#${id}`).disabled = !selected.size || loading;
    for (const id of ['directory-open', 'directory-copy', 'directory-export']) root.querySelector(`#${id}`).disabled = loading || !ready || !data?.total;
  };
  const load = async (force = false) => {
    const token = ++ticket; loading = true; ready = false; selection(); table.classList.add('is-loading');
    save();
    try {
      const response = await requestData('/api/query/start', { ...spec(), refresh: force }, job => jobBanner(progress, job));
      if (!root.isConnected || token !== ticket) return;
      data = response; ready = true;
      list?.destroy();
      list = new ResultTable(table, { selected, sort, layoutKey:'directory', onSelection: selection, onReload: () => load(),
        onSort: field => { sort = { field, desc: sort.field === field ? !sort.desc : false }; load(); },
        onRowDoubleClick: row => { state.workbenchGroups=[row.group_id]; state.workbenchMode='memberships'; navigate('members'); },
        onDetail: row => showDetails(spec(), row) });
      list.setData(data, dataColumns(data, { selected }));
      root.querySelector('#directory-total').textContent = `${fmtNumber(data.total)} 个群`;
    } catch (error) {
      ready = false;
      if (root.isConnected && token === ticket) { if (!data) table.innerHTML = errorBox(error); else toast(error.message, 'err', error.hint); }
    } finally { if (token === ticket) { loading = false; table.classList.remove('is-loading'); selection(); } }
  };
  reload = load;
  new FilterBar(root.querySelector('#directory-filter'), { rule, entity: 'groups', onApply(value) { rule = value; selected.clear(); load(); } });
  root.querySelector('#directory-search').addEventListener('change', event => { search = event.target.value.trim(); selected.clear(); load(); });
  root.querySelector('#directory-refresh').addEventListener('click', () => { selected.clear(); load(true); });
  root.querySelector('#directory-clear').addEventListener('click', () => { selected.clear(); list?.schedule(); selection(); });
  root.querySelector('#directory-columns').addEventListener('click', () => chooseColumns(columns, value => { columns = value; load(); }, 'groups'));
  root.querySelector('#directory-group-field').value = groupBy.field || '';
  root.querySelector('#directory-group-apply').addEventListener('click', () => {
    groupBy = { field: root.querySelector('#directory-group-field').value, pattern: root.querySelector('#directory-group-pattern').value };
    root.querySelector('.display-options').open = false; selected.clear(); load();
  });
  root.querySelector('#directory-copy').addEventListener('click', () => exportData({ query_id: data.query_id, selected: selected.size ? [...selected] : undefined }, 'tsv', progress));
  root.querySelector('#directory-export').addEventListener('click', () => exportData({ query_id: data.query_id, selected: selected.size ? [...selected] : undefined }, root.querySelector('#directory-format').value, progress));
  root.querySelector('#directory-open').addEventListener('click', async () => {
    try {
      const ids = selected.size ? [...selected] : (await allResultRows(data)).map(row => row.id);
      state.workbenchGroups = ids; navigate('members');
    } catch (error) { toast(error.message, 'err', error.hint); }
  });
  root.querySelector('#directory-settings').addEventListener('click', () => openGroupSettings([...selected], progress));
  root.querySelector('#directory-favorite').addEventListener('click', () => {
    const favorites = new Set(loadPrefs().favoriteGroups || []);
    const remove = [...selected].every(gid => favorites.has(gid));
    selected.forEach(gid => { if (remove) favorites.delete(gid); else favorites.add(gid); });
    savePrefs({ favoriteGroups: [...favorites] }); load();
  });
  root.querySelector('#directory-collect').addEventListener('click', () => collect([...selected], progress, false, () => load()));
  root.querySelector('#directory-retry').addEventListener('click', () => collect([...selected], progress, true, () => load()));
  await load();
  if (state.pendingGroupSettings) { state.pendingGroupSettings = false; if (state.group) openGroupSettings([state.group.group_id], progress); }
}

export async function refresh() { await reload?.(true); }
