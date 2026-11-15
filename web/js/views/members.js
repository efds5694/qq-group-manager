import { state, loadPrefs, savePrefs, groupDisplayName } from '../state.js';
import { esc, fmtNumber } from '../ui.js';
import { FilterBar, catalog, emptyRule, fieldSelectOptions } from '../filters.js';
import { initialize, requestData, jobBanner, scopeContext, tableHtml, bindTable, showDetails, chooseColumns,
  chooseGroups, exportData, collect, errorBox, defaultSources, names } from '../workspace.js';
import { openRename } from '../actions.js';
import { bindAutoPage } from '../pagination.js';

let reload = null;

export async function render(container) {
  await initialize();
  const key = `workbench.${state.session?.login?.user_id || 'local'}`;
  const prefs = loadPrefs()[key] || {};
  const available = new Set(state.groups.map(group => group.group_id));
  const incoming = state.workbenchGroups ?? state.crossGroupTargets;
  let groupIds = (incoming ?? prefs.groupIds ?? (state.group ? [state.group.group_id] : defaultSources())).filter(gid => available.has(gid));
  state.workbenchGroups = state.crossGroupTargets = null;
  let sources = (prefs.sources ?? defaultSources()).filter(gid => available.has(gid));
  let mode = state.workbenchMode || prefs.mode || 'memberships';
  state.workbenchMode = null;
  let rule = prefs.rule || emptyRule();
  let columns = prefs.columns || catalog.member_columns;
  let matrixField = prefs.matrixField || 'member.card';
  let sort = prefs.sort || { field: 'member.qq', desc: false };
  let groupBy = prefs.groupBy || {};
  let search = prefs.search || '';
  let page = 1;
  let selected = new Set();
  let range = 'filtered';
  let data = null;
  let ticket = 0;
  let loading = false;
  let scrollLeft = 0;
  container.innerHTML = `<div class="page members-workspace"><div class="page-head"><div><span class="eyebrow">MEMBER WORKSPACE</span><h1>成员工作台</h1><p>一套条件查看资料、比较群分布，并对结果执行操作。</p></div><div class="page-actions"><button class="btn" id="members-refresh">刷新名单</button><button class="btn btn-primary" id="members-rename">改群昵称</button></div></div>
    <div class="scope-strip"><div><span class="eyebrow">查看范围</span><strong id="members-scope-label"></strong><span id="members-scope-names"></span></div><button class="btn btn-sm" id="members-scope">选择群聊</button><span class="scope-strip-divider"></span><details class="source-settings"><summary class="btn btn-sm">基准群与优先级 <span id="members-source-count"></span></summary><div class="source-settings-panel"><p class="tiny muted">参考资料按顺序采用第一个非空群昵称。基准可在查看范围外，不计入所在群数。</p><div id="members-sources"></div><div class="row"><button class="btn btn-sm" id="members-pick-sources">选择基准群</button><button class="btn btn-sm btn-text" id="members-default-sources">默认【师生】群</button><button class="btn btn-sm btn-text" id="members-include-sources">加入查看范围</button></div></div></details></div>
    <section class="workspace-card"><div class="workspace-search"><div class="view-tabs"><button data-mode="memberships">成员明细</button><button data-mode="people">跨群分布</button></div><input class="input" id="members-search" placeholder="搜索昵称、群昵称、QQ号或群显示名" aria-label="搜索成员" value="${esc(search)}"/><span class="workspace-total" id="members-total">读取中</span></div><div id="members-filter" class="shared-filter"></div>
      <div class="workspace-toolbar"><select class="input operation-range" id="members-range" aria-label="操作范围"><option value="filtered">当前全部筛选结果</option><option value="selected">仅勾选的记录</option></select><span id="members-selection" class="tiny muted"></span><button class="btn btn-sm btn-text" id="members-clear">取消勾选</button><span class="spacer"></span>
        <label class="matrix-field-label" id="matrix-field-label">单元格字段<select class="input" id="matrix-field">${fieldSelectOptions(matrixField)}</select></label><button class="btn btn-sm" id="members-columns">字段</button>
        <details class="display-options"><summary class="btn btn-sm">分组</summary><div><label>分组字段<select class="input" id="members-group-field"><option value="">不分组</option>${fieldSelectOptions(groupBy.field)}</select></label><label>提取分组的正则（可选）<input class="input mono" id="members-group-pattern" value="${esc(groupBy.pattern || '')}" placeholder="例如 ^(\\d{4})"/></label><button class="btn btn-sm" id="members-group-apply">应用分组</button></div></details>
        <button class="btn btn-sm" id="members-copy">复制表格</button><select class="input format-select" id="members-format" aria-label="导出格式">${(state.config?.formats || ['csv']).map(format => `<option>${format}</option>`).join('')}</select><button class="btn btn-sm" id="members-export">导出</button></div>
      <div id="members-progress" hidden></div><div class="table-wrap workspace-table" id="members-table"></div><div class="workspace-pagination"><span id="members-page" class="tiny muted"></span><span class="spacer"></span><button class="btn btn-sm" id="members-prev">上一页</button><button class="btn btn-sm" id="members-next">下一页</button></div></section>
    <div class="workspace-secondary-actions"><button class="btn btn-text btn-sm" id="members-collect">补全范围内资料</button><button class="btn btn-text btn-sm" id="members-retry">重试采集失败项</button><span class="tiny faint" id="members-data-note"></span></div></div>`;
  const root = container.querySelector('.members-workspace');
  const table = root.querySelector('#members-table');
  const progress = root.querySelector('#members-progress');
  const spec = (useRange = false) => ({ entity: mode, scope: scopeContext(groupIds, sources), filter: rule, fields: columns, sort,
    search, page, size: 50, matrix_field: matrixField, group_by: groupBy, selected: useRange && range === 'selected' ? [...selected] : undefined });
  const save = () => savePrefs({ [key]: { groupIds, sources, mode, rule, columns, matrixField, sort, groupBy, search } });
  const selection = () => {
    root.querySelector('#members-selection').textContent = `已勾选 ${selected.size} ${mode === 'people' ? '人' : '条记录'}`;
    root.querySelector('#members-clear').disabled = !selected.size;
    const disabled = loading || !data?.total || (range === 'selected' && !selected.size);
    for (const id of ['members-rename', 'members-copy', 'members-export']) root.querySelector(`#${id}`).disabled = disabled;
  };
  const clear = () => { selected.clear(); range = 'filtered'; root.querySelector('#members-range').value = range; };
  const paintScope = () => {
    root.querySelector('#members-scope-label').textContent = `${groupIds.length} 个群`;
    root.querySelector('#members-scope-names').textContent = names(groupIds).join('、') || '请先选择群聊';
    root.querySelector('#members-source-count').textContent = `(${sources.length})`;
    root.querySelector('#members-sources').innerHTML = sources.map((gid, index) => `<div class="source-order-row"><span>${index+1}</span><strong title="${esc(names([gid])[0])}">${esc(names([gid])[0])}</strong><button class="icon-btn" data-source-move="${esc(gid)}" data-step="-1" ${index ? '' : 'disabled'} title="提高优先级">↑</button><button class="icon-btn" data-source-move="${esc(gid)}" data-step="1" ${index < sources.length-1 ? '' : 'disabled'} title="降低优先级">↓</button></div>`).join('') || '<p class="tiny faint">尚未选择基准群。</p>';
    root.querySelectorAll('[data-source-move]').forEach(button => button.addEventListener('click', () => {
      const index = sources.indexOf(button.dataset.sourceMove), other = index + Number(button.dataset.step);
      [sources[index], sources[other]] = [sources[other], sources[index]]; clear(); paintScope(); load();
    }));
  };
  const load = async (force = false) => {
    const token = ++ticket; loading = true; data = null;
    if (table.querySelector('table')) scrollLeft = table.scrollLeft;
    table.scrollTop = 0;
    table.innerHTML = '<div class="skeleton table-loading"></div>';
    root.querySelectorAll('[data-mode]').forEach(button => button.classList.toggle('active', button.dataset.mode === mode));
    root.querySelector('#matrix-field-label').hidden = mode !== 'people';
    root.querySelector('#members-prev').disabled = root.querySelector('#members-next').disabled = true;
    selection(); save();
    if (!groupIds.length) {
      table.innerHTML = '<div class="empty"><strong>选择要查看的群聊</strong><p>可以选择单个群，也可以组合多个群。</p></div>';
      root.querySelector('#members-total').textContent = '尚未选择群'; loading = false; selection(); return;
    }
    try {
      const response = await requestData('/api/query', { ...spec(), refresh: force }, job => jobBanner(progress, job));
      if (!root.isConnected || token !== ticket) return;
      data = response; page = data.page;
      table.innerHTML = tableHtml(data, selected, { matrix: mode === 'people', matrixField }); table.scrollLeft = scrollLeft;
      bindTable(table, data, selected, () => { if (selected.size) { range = 'selected'; root.querySelector('#members-range').value = range; } selection(); },
        field => { sort = { field, desc: sort.field === field ? !sort.desc : false }; load(); }, (row, gid) => showDetails(spec(), row, gid));
      root.querySelector('#members-total').textContent = `${fmtNumber(data.people)} 人 · ${fmtNumber(data.memberships)} 条记录`;
      root.querySelector('#members-page').textContent = `第 ${page} / ${data.pages} 页 · ${fmtNumber(data.total)} ${mode === 'people' ? '人' : '条群成员记录'}${data.pages > 1 ? page < data.pages ? ' · 触底自动下一页' : ' · 已到最后一页' : ''}`;
      root.querySelector('#members-prev').disabled = page <= 1; root.querySelector('#members-next').disabled = page >= data.pages;
      root.querySelector('#members-data-note').textContent = mode === 'people'
        ? '矩阵保留真实群关系；“匹配”标记对应命中的记录，未标记的已有记录不会当成未加入。'
        : data.groups.some(group => group.stale) ? '部分群使用旧缓存，可刷新名单；筛选需要额外资料时自动补全。' : '资料按需加载；未采集、采集失败与未提供分别显示。';
      return true;
    } catch (error) {
      if (root.isConnected && token === ticket) { table.innerHTML = errorBox(error); root.querySelector('#members-total').textContent = '查询未完成'; }
      return false;
    } finally { if (token === ticket) { loading = false; selection(); } }
  };
  const changePage = async next => {
    if (loading || !data || next < 1 || next > data.pages) return;
    const previous = page;
    page = next;
    if (await load() === false) page = previous;
  };
  bindAutoPage(table, () => !loading && data && page < data.pages, () => changePage(page + 1));
  reload = load;
  new FilterBar(root.querySelector('#members-filter'), { rule, onApply(value) { rule = value; page = 1; clear(); load(); } });
  root.querySelector('#members-scope').addEventListener('click', () => chooseGroups({ selected: groupIds, onApply(ids) { groupIds = ids; page = 1; clear(); scrollLeft = 0; paintScope(); load(); } }));
  root.querySelector('#members-pick-sources').addEventListener('click', () => chooseGroups({ title: '选择基准群', selected: sources, onApply(ids) { sources = ids; clear(); paintScope(); load(); } }));
  root.querySelector('#members-default-sources').addEventListener('click', () => { sources = defaultSources(); clear(); paintScope(); load(); });
  root.querySelector('#members-include-sources').addEventListener('click', () => { groupIds = [...new Set([...sources, ...groupIds])]; clear(); paintScope(); load(); });
  root.querySelector('#members-search').addEventListener('change', event => { search = event.target.value.trim(); page = 1; clear(); load(); });
  root.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => { mode = button.dataset.mode; page = 1; clear(); scrollLeft = 0; load(); }));
  root.querySelector('#members-clear').addEventListener('click', () => { clear(); load(); });
  root.querySelector('#members-range').addEventListener('change', event => { range = event.target.value; selection(); });
  root.querySelector('#matrix-field').value = matrixField;
  root.querySelector('#matrix-field').addEventListener('change', event => { matrixField = event.target.value; clear(); load(); });
  root.querySelector('#members-columns').addEventListener('click', () => chooseColumns(columns, value => { columns = value; load(); }));
  root.querySelector('#members-group-field').value = groupBy.field || '';
  root.querySelector('#members-group-apply').addEventListener('click', () => {
    groupBy = { field: root.querySelector('#members-group-field').value, pattern: root.querySelector('#members-group-pattern').value };
    root.querySelector('.display-options').open = false; clear(); page = 1; load();
  });
  root.querySelector('#members-refresh').addEventListener('click', () => { clear(); load(true); });
  root.querySelector('#members-prev').addEventListener('click', () => changePage(page - 1));
  root.querySelector('#members-next').addEventListener('click', () => changePage(page + 1));
  root.querySelector('#members-copy').addEventListener('click', () => exportData(spec(true), 'tsv', progress));
  root.querySelector('#members-export').addEventListener('click', () => exportData(spec(true), root.querySelector('#members-format').value, progress));
  root.querySelector('#members-rename').addEventListener('click', () => openRename(spec(true), progress, () => { clear(); load(true); }));
  root.querySelector('#members-collect').addEventListener('click', () => collect(groupIds, progress, false, () => load()));
  root.querySelector('#members-retry').addEventListener('click', () => collect(groupIds, progress, true, () => load()));
  paintScope(); await load();
  if (state.pendingRename) { state.pendingRename = false; if (data?.total) openRename(spec(true), progress, () => { clear(); load(true); }); }
}

export async function refresh() { await reload?.(true); }
