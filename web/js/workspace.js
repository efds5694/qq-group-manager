// 桌面工作台共用查询、群选择、列选择、资料详情与导出。
import * as api from './api.js';
import { state, setGroups, loadPrefs, groupDisplayName } from './state.js';
import { esc, openDrawer, closeDrawer, toast, copyText, downloadFile, fmtNumber } from './ui.js';
import { catalog, loadCatalog, mergeFields, clone, emptyRule } from './filters.js';
import { ResultTable, dataColumns, readResultIds } from './result-table.js';
import { detailSections, renderField, groupTag, groupTray, fieldStatusTag } from './field-display.js';
import { GROUP_SEARCH, matchesGroup, mountQueryBar, mountSearch } from './search-controls.js';

export async function initialize(element) {
  if (element) element.innerHTML = '<div class="page"><div id="initialize-progress" role="status"></div></div>';
  const progress = element?.querySelector('#initialize-progress');
  jobBanner(progress, { kind:'load', status:'running', title:'准备群聊资料', started_at:Date.now()/1000 });
  await loadCatalog();
  const data = await requestData('/api/groups/load', { show_remark:loadPrefs().showRemark !== false }, job => jobBanner(progress, job));
  setGroups(data.groups);
  return data.groups;
}

export async function requestData(path, body, onProgress, isActive = () => true) {
  const background = ['/api/query/start','/api/query','/api/groups/load','/api/members/compare','/api/rename/preview','/api/settings/preview','/api/data/collect',
    '/api/members/match-roster','/api/members/actions/preview'].includes(path)
    || /^\/api\/rosters\/[a-f0-9]{32}\/(bind|sync)$/.test(path);
  const stage = {kind:'load', status:'running', title:'正在读取资料', started_at:Date.now()/1000};
  const report = job => { if (isActive()) onProgress?.(job); };
  if (!isActive()) return null;
  report(stage);
  const timer = setInterval(() => report(stage), 1000);
  let data;
  try {
    try { data = await api.post(path, { ...body, ...(background ? {background:true} : {}) }); }
    finally { clearInterval(timer); }
    while (isActive() && data.pending) {
      const job = await api.pollJob(data.job.id, report, undefined, isActive);
      if (!job || !isActive()) return null;
      if (job.status === 'canceled') throw new Error('资料读取或补全已中止，当前结果未更新。');
      if (job.kind === 'load') {
        if (job.status === 'failed') throw new api.ApiError(job.error || '资料读取失败', job.hint, job.error_code);
        data = job.result;
      } else data = await api.post(path, { ...body, refresh: false, ...(background ? {background:true} : {}) });
    }
    if (!isActive()) return null;
    report({...stage, status:'done'});
    if (data.fields) mergeFields(data.fields);
    return data;
  } catch (error) {
    if (!isActive()) return null;
    report({...stage, status:'failed', error:error.message});
    throw error;
  }
}

export function jobBanner(element, job, onFinish) {
  if (!element?.isConnected) return;
  const running = ['pending', 'running'].includes(job.status);
  if (job.kind === 'load' && !running) { element.hidden = job.status === 'done'; if (!element.hidden) element.innerHTML = errorBox({message:job.error || '资料读取未完成'}); return; }
  element.hidden = false;
  const elapsed = Math.max(0, Math.floor(Date.now()/1000 - (job.started_at || job.created_at || Date.now()/1000)));
  const percent = job.total ? Math.min(100, Math.round((job.cursor || 0) / job.total * 100)) : null;
  element.innerHTML = `<div class="job-strip"><span class="job-strip-dot ${running ? 'busy' : ''}"></span><strong>${esc(job.title)}</strong><span>${esc(job.phase || '')}</span><span>${job.kind === 'load' ? `${percent === null ? '读取中' : `${job.cursor} / ${job.total} · ${percent}%`} · 已用 ${elapsed} 秒` : `${job.cursor} / ${job.total} · 成功 ${job.ok} · 失败 ${job.fail}`}</span><span class="spacer"></span>${running && job.id ? '<button class="btn btn-sm" data-cancel-job type="button">中止</button>' : running ? '' : '<a class="btn btn-sm" href="#/tasks">查看任务</a>'}<div class="read-progress ${percent === null ? 'indeterminate' : ''}" role="progressbar" aria-label="${esc(job.phase || job.title)}"${percent === null ? '' : ` aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"`}><span style="width:${percent ?? 35}%"></span></div></div>`;
  element.querySelector('[data-cancel-job]')?.addEventListener('click', async () => {
    await api.post(`/api/jobs/${job.id}/cancel`, {}); toast('已请求中止', 'warn');
  });
  if (!running) onFinish?.();
}

export class ResultQuery {
  constructor(progress, { isActive, onChange }) {
    this.progress = progress;
    this.isActive = isActive;
    this.onChange = onChange;
    this.revision = 0;
    this.ready = this.loading = this.hasResult = false;
  }

  dispose() { this.revision++; }

  reset() {
    this.dispose();
    this.ready = this.loading = this.hasResult = false;
    this.progress.hidden = true;
    this.onChange();
  }

  async run(read, show, retry) {
    const revision = ++this.revision;
    const current = () => this.revision === revision && this.isActive();
    if (!current()) return;
    this.ready = false;
    this.loading = true;
    this.onChange();
    try {
      const data = await read(job => { if (current()) jobBanner(this.progress, job); }, current);
      if (!current()) return;
      show(data);
      this.hasResult = this.ready = true;
      this.progress.hidden = true;
    } catch (error) {
      if (!current()) return;
      const title = this.hasResult ? '查询失败，仍显示上次结果' : '查询失败';
      this.progress.hidden = false;
      this.progress.innerHTML = `<div class="query-error query-retry" role="alert"><div><strong>${title}</strong><p>${esc(error.message)}${error.hint ? ' · ' + esc(error.hint) : ''}</p></div><button class="btn btn-sm" type="button">重试查询</button></div>`;
      this.progress.querySelector('button').addEventListener('click', retry);
    } finally {
      if (current()) { this.loading = false; this.onChange(); }
    }
  }
}

export function workspaceTabs(section, current) {
  const items = section === 'members' ? [['members', '人员总览'], ['members/rename', '改群昵称']]
    : [['lists', '入群跟踪'], ['lists/compare', '群关系核对']];
  return `<nav class="member-task-tabs" aria-label="${section === 'members' ? '成员页面' : '名单与邀请页面'}">${items.map(([route, label]) =>
    `<a href="#/${route}"${route === current ? ' class="active" aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
}

export async function collect(groupIds, element, retryFailed = false, onFinish) {
  if (!groupIds.length) { toast('请先选择群', 'warn'); return; }
  try {
    const data = await requestData('/api/data/collect', { group_ids: groupIds, retry_failed: retryFailed }, job => jobBanner(element, job));
    await api.pollJob(data.job.id, job => jobBanner(element, job));
    toast('资料采集任务已结束', 'ok', '失败或不支持的接口可在任务中心查看。');
    await onFinish?.();
  } catch (error) { toast(error.message, 'err', error.hint); }
}

export function scopeContext(groupIds, sourceIds = []) {
  return { group_ids: [...groupIds], source_group_ids: [...sourceIds], favorite_ids: loadPrefs().favoriteGroups || [],
    show_remark: loadPrefs().showRemark !== false };
}

export function groupSelection(chosen, matching) {
  const finalIds = [], storedIds = [];
  for (const id of chosen) (matching.has(id) ? finalIds : storedIds).push(id);
  return { finalIds, storedIds };
}

export function chooseGroups({ title = '选择群聊范围', selected = [], excluded = [], onApply }) {
  const excludedIds = new Set(excluded);
  const chosen = new Set(selected.filter(gid => !excludedIds.has(gid)));
  let rule = emptyRule(), search = '', storedSearch = '', list, storedList;
  let matching = new Set(), available = [];
  openDrawer({ title, wide: true,
    body: `<div id="scope-query"></div>
      <div id="scope-progress" hidden></div><div id="scope-results" class="scope-results"></div>
      <details class="scope-stored" id="scope-stored"><summary><strong id="scope-stored-summary">筛选外暂存</strong><span>展开查看与管理</span></summary>
        <p class="settings-help">切换筛选时暂存勾选。点击应用时，只使用当前筛选内的勾选。</p>
        <div class="scope-stored-tools"><label class="check-inline"><input type="checkbox" id="scope-stored-all"/>显示全部筛选外群</label><button class="btn btn-sm" id="scope-stored-clear">取消全部暂存</button><div id="scope-stored-search"></div></div>
        <div id="scope-stored-results" class="scope-results"></div></details>`,
    footer: '<div class="scope-selection-count" role="status"><strong id="scope-count"></strong><span class="tiny muted" id="scope-count-detail"></span></div><button class="btn" id="scope-clear">清空全部勾选</button><button class="btn" data-close="1">取消</button><button class="btn btn-primary" id="scope-apply">应用群范围</button>',
    onMount(panel, foot) {
      const results = panel.querySelector('#scope-results');
      const storedHost = panel.querySelector('#scope-stored-results');
      const storedDetails = panel.querySelector('#scope-stored');
      const progress = panel.querySelector('#scope-progress');
      const isActive = () => results.isConnected && !results.closest('[aria-hidden="true"]');
      const query = new ResultQuery(progress, { isActive, onChange() {
        list?.setLoading(!query.ready); storedList?.setLoading(!query.ready);
        count();
        if (query.ready) paintStored();
      } });
      const busy = () => !query.ready || Boolean(list?.selectionBusy || storedList?.selectionBusy);
      const count = () => {
        if (!isActive()) return;
        const { finalIds, storedIds } = groupSelection(chosen, matching);
        foot.querySelector('#scope-count').textContent = query.ready ? `最终范围 ${finalIds.length} 个群`
          : query.loading ? '正在确定最终范围…' : '等待确定最终范围';
        foot.querySelector('#scope-count-detail').textContent = query.ready
          ? `当前结果 ${matching.size} 个群 · 筛选外暂存 ${storedIds.length} 个群` : `本次窗口共勾选 ${chosen.size} 个群`;
        const apply = foot.querySelector('#scope-apply');
        apply.disabled = busy();
        apply.textContent = query.ready ? `应用 ${finalIds.length} 个群` : '应用群范围';
        foot.querySelector('#scope-clear').disabled = busy() || !chosen.size;
        panel.querySelector('#scope-stored-summary').textContent = `筛选外暂存 ${storedIds.length} 个群`;
        panel.querySelector('#scope-stored-clear').disabled = busy() || !storedIds.length;
        panel.querySelector('#scope-stored-all').disabled = busy();
        storedControl.setDisabled(busy());
      };
      const paintStored = () => {
        if (!query.ready || !isActive()) return;
        const scrollTop = storedList?.viewport.scrollTop || 0;
        storedList?.destroy(); storedList = null;
        if (!storedDetails.open) { storedHost.innerHTML = ''; return; }
        const { storedIds } = groupSelection(chosen, matching);
        const all = panel.querySelector('#scope-stored-all').checked;
        const groupMap = new Map(available.map(group => [group.group_id, group]));
        const groupDetails = new Map(state.groups.map(group => [group.group_id, group]));
        const ids = all ? [...new Set([...groupMap.keys(), ...storedIds])].filter(id => !matching.has(id)) : storedIds;
        const rows = ids.map(id => ({ ...groupDetails.get(id), id, group_id:id,
          name:groupMap.get(id)?.name || groupDisplayName(groupDetails.get(id)) || id }))
          .filter(group => matchesGroup(group, storedSearch))
          .sort((a,b) => a.name.localeCompare(b.name, 'zh-CN', {numeric:true}))
          .map(group => ({ ...group, values:{'group.display_name':group.name,'group.group_id':group.id},
            display:{'group.display_name':group.name,'group.group_id':group.id} }));
        if (!rows.length) {
          storedHost.innerHTML = `<p class="scope-stored-empty">${storedSearch ? '没有匹配的筛选外群。' : all ? '当前没有筛选外群。' : '没有筛选外暂存。勾选上方“显示全部筛选外群”可以查找并暂存其他群。'}</p>`;
          count(); return;
        }
        const data = { fields:catalog.fields, groups:[], columns:['group.display_name','group.group_id'] };
        storedList = new ResultTable(storedHost, {selected:chosen, layoutKey:'group-picker-stored', onSelection() {
          count(); list?.schedule();
          if (!storedList?.selectionBusy && !panel.querySelector('#scope-stored-all').checked) paintStored();
        }});
        storedList.setLocal(rows, dataColumns(data, {selected:chosen,detail:false,search:storedSearch}));
        const current = storedList;
        requestAnimationFrame(() => {
          if (storedList === current && !current.disposed) current.viewport.scrollTop = scrollTop;
        });
        count();
      };
      const load = () => {
        const filter = excluded.length ? { op:'and', rules:[rule, {op:'not',rules:[{field:'group.group_id',op:'in',value:excluded}]}] } : rule;
        return query.run(async (report, current) => {
          const data = await requestData('/api/query/start', { entity:'groups', filter, search, scope:scopeContext([]),
            fields:['group.display_name','group.group_id','group.member_count','group.my_role'] }, report, current);
          if (current()) return { data, ids: await readResultIds(data) };
        }, ({ data, ids }) => {
          matching = new Set(ids);
          available = (data.groups || []).filter(group => !excludedIds.has(group.group_id));
          list?.destroy();
          list = new ResultTable(results, {selected:chosen, layoutKey:'group-picker', onSelection:count, onReload:load});
          list.setData({...data, selection_ids:ids}, dataColumns(data, {selected:chosen,detail:false,search}));
        }, load);
      };
      mountQueryBar(panel.querySelector('#scope-query'), {
        search: { label: '搜索群范围', placeholder: GROUP_SEARCH, onSubmit(value) { search = value; load(); } },
        filter: { compact: true, entity: 'groups', onApply(value) { rule = value; load(); } },
      });
      const storedControl = mountSearch(panel.querySelector('#scope-stored-search'), {
        label: '搜索筛选外群', placeholder: GROUP_SEARCH,
        onSubmit(value) {
          storedSearch = value;
          if (storedList) storedList.viewport.scrollTop = 0;
          paintStored();
        },
      });
      storedDetails.addEventListener('toggle', paintStored);
      panel.querySelector('#scope-stored-all').addEventListener('change', paintStored);
      panel.querySelector('#scope-stored-clear').addEventListener('click', () => {
        if (busy()) return;
        groupSelection(chosen,matching).storedIds.forEach(id => chosen.delete(id));
        count(); list?.schedule(); paintStored();
      });
      foot.querySelector('#scope-clear').addEventListener('click', () => {
        if (busy()) return;
        chosen.clear(); count(); list?.schedule(); paintStored();
      });
      foot.querySelector('#scope-apply').addEventListener('click', () => {
        if (busy()) return;
        const {finalIds} = groupSelection(chosen,matching);
        query.dispose(); list?.destroy(); storedList?.destroy(); closeDrawer(); onApply(finalIds);
      });
      count(); load();
    },
  });
}

export function errorBox(error) {
  return `<div class="query-error" role="alert"><strong>${esc(error.message)}</strong>${error.hint ? `<p>${esc(error.hint)}</p>` : ''}</div>`;
}

export function chooseColumns(columns, onApply, entity = 'memberships') {
  const selected = new Set(columns);
  const mandatory = entity === 'groups' ? ['group.display_name'] : ['member.qq', 'member.nickname'];
  openDrawer({ title: '选择显示与导出的字段', wide: true,
    body: '<input class="input" id="column-search" placeholder="搜索字段名称或原始字段路径" aria-label="搜索可用字段"/><div class="column-options" id="column-list"></div>',
    footer: '<button class="btn" data-close="1">取消</button><button class="btn btn-primary" id="columns-apply">应用字段</button>',
    onMount(panel, foot) {
      const paint = (text = '') => {
        const allowed = field => entity === 'groups' ? field.id.startsWith('group.') : entity === 'people'
          ? ['member.qq','member.nickname','person.group_count','person.group_names','person.in_all'].includes(field.id) : !field.id.startsWith('comparison.');
        panel.querySelector('#column-list').innerHTML = catalog.fields.filter(field => allowed(field) && `${field.label} ${field.id}`.toLowerCase().includes(text.toLowerCase())).map(field => `<label class="column-option"><input type="checkbox" value="${esc(field.id)}" ${selected.has(field.id) || mandatory.includes(field.id) ? 'checked' : ''} ${mandatory.includes(field.id) ? 'disabled' : ''}/><span><strong>${esc(field.label)}</strong><span class="tiny faint">${esc(field.source)} · ${esc(field.type)}</span></span></label>`).join('');
      };
      panel.querySelector('#column-list').addEventListener('change', event => { if (event.target.checked) selected.add(event.target.value); else selected.delete(event.target.value); });
      panel.querySelector('#column-search').addEventListener('input', event => paint(event.target.value));
      foot.querySelector('#columns-apply').addEventListener('click', () => { closeDrawer(); onApply([...new Set([...mandatory, ...selected])]); });
      paint();
    },
  });
}

export async function showDetails(spec, row, gid) {
  const actualGid = gid || row.group_id;
  const body = { ...clone(spec), entity: row.qq ? 'memberships' : 'groups', filter: emptyRule(), search: '', details: true,
    scope: scopeContext([actualGid]), selected: [row.qq ? `${actualGid}:${row.qq}` : row.id], fields: catalog.fields.map(field => field.id), page: 1 };
  openDrawer({ title: row.qq ? `成员资料 · ${row.qq}` : `群聊资料 · ${row.id}`, wide: true,
    body: '<div class="skeleton" style="height:180px"></div>', footer: '<button class="btn" data-close="1">关闭</button>',
    onMount: async panel => {
      try {
        const data = await requestData('/api/query', body);
        const item = data.items[0];
        if (!item || !panel.isConnected) return;
        const sections = detailSections(catalog.fields, Boolean(row.qq));
        const groupName = item.display['group.display_name'] || actualGid;
        const sources = row.source_values || [];
        const sourceHeader = sources.length ? `<section class="source-alternatives"><h3>本次列表中的昵称来源 ${new Set(sources.map(source=>source.text)).size>1 ? fieldStatusTag('来源有差异','warning') : ''}</h3>${sources.map((source,index)=>`<p>${groupTag(source.name,source.group_id)} → <strong>${esc(source.text)}</strong> ${index===0?fieldStatusTag('采用','info'):''}</p>`).join('')}</section>` : '';
        const rawBlocks = [{label:'群聊接口原始资料与采集状态',value:{data:item.raw?.group,collection:item.raw?.collection?.group}}];
        if(row.qq)rawBlocks.unshift({label:'本人成员接口原始资料与采集状态',value:{data:item.raw?.member,collection:item.raw?.collection?.members?.[row.qq]}});
        panel.innerHTML = `${sourceHeader}${sections.map(section=>`<section class="detail-section" aria-labelledby="detail-${section.id}"><header class="detail-section-head"><div><h3 id="detail-${section.id}">${section.title}</h3><p>${section.description}</p></div>${section.id!=='personal'?groupTag(groupName,actualGid):''}</header><dl class="record-details">${section.fields.map(field=>`<div><dt>${esc(field.label)}</dt><dd>${renderField(item,field.id,'（空）')}</dd></div>`).join('')}</dl></section>`).join('')}
          ${rawBlocks.map(block=>`<details class="raw-details"><summary>${block.label}</summary><pre>${esc(JSON.stringify(block.value,null,2))}</pre></details>`).join('')}`;

      } catch (error) { if (panel.isConnected) panel.innerHTML = errorBox(error); }
    },
  });
}

export async function exportData(spec, format, progressElement) {
  try {
    const response = await requestData('/api/query/export', { ...spec, format }, job => jobBanner(progressElement, job));
    if (format === 'tsv') { await copyText(await response.text()); toast('已复制当前范围的完整表格', 'ok'); return; }
    await downloadFile(response, `群务资料.${format}`);
  } catch (error) { toast(error.message, 'err', error.hint); }
}

export const defaultSources = () => state.groups.filter(group => /^【师生】/.test(groupDisplayName(group)))
  .sort((a, b) => groupDisplayName(a).localeCompare(groupDisplayName(b), 'zh-CN', { numeric: true })).map(group => group.group_id);

export function names(groupIds) { return groupIds.map(gid => groupDisplayName(state.groups.find(group => group.group_id === gid)) || gid); }

export function showPersonDetails(spec, row, gid) {
  if (gid) { showDetails(spec, row, gid); return; }
  const memberships = row.memberships || [];
  openDrawer({ title: `各群资料 · ${row.display?.['member.nickname'] || row.qq} · ${row.qq}`, wide: true,
    body: `<p class="scope-description">在本次查看范围内加入 ${memberships.length} 个群。下面列出实际群关系，条件未匹配的记录仍保留。</p>
      ${row.person?.source_values?.length ? `<details class="source-alternatives"><summary>昵称来源与采用顺序${row.person.source_conflict ? ' · 来源存在差异' : ''}</summary>${row.person.source_values.map((source,i) => `<p>${i+1}. ${groupTag(source.name,source.group_id)} → <strong>${esc(source.text)}</strong>${i===0?'（采用）':''}</p>`).join('')}</details>` : ''}<div id="person-memberships" class="scope-results"></div>`,
    footer: '<button class="btn" data-close="1">关闭</button>',
    onMount(panel) {
      const data = { fields: catalog.fields, columns: ['group.display_name','member.card','member.role'], groups: [] };
      const items = memberships.map(member => ({ ...member, id: `${member.group_id}:${row.qq}`, qq: row.qq,
        display: { ...member.display, 'group.display_name': names([member.group_id])[0] },
        values: { ...member.values, 'group.display_name': names([member.group_id])[0] } }));
      const list = new ResultTable(panel.querySelector('#person-memberships'), { layoutKey:'person-memberships', onDetail: member => showDetails(spec, member, member.group_id) });
      list.setLocal(items, dataColumns(data, {navigateGroups:true}));
    },
  });
}

export function scopeCard(label, ids, button, description = '') {
  const groupNames = names(ids);
  return `<section class="task-scope-card"><div class="task-scope-head"><span ${description ? `tabindex="0" data-help="${esc(description)}"` : ''}>${esc(label)}</span><strong>${ids.length} 个群</strong>
    ${ids.length ? groupTray(ids.map((id, index) => [id, groupNames[index]])) : '<span class="spacer"></span>'}
    <button class="btn btn-sm" id="${button}">选择群聊</button></div></section>`;
}
