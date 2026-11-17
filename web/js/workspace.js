// 桌面工作台共用查询、群选择、列选择、资料详情与导出。
import * as api from './api.js';
import { state, setGroups, loadPrefs, groupDisplayName } from './state.js';
import { esc, openDrawer, closeDrawer, toast, copyText, fmtNumber } from './ui.js';
import { FilterBar, catalog, loadCatalog, mergeFields, clone, emptyRule } from './filters.js';
import { ResultTable, dataColumns } from './result-table.js';
import { detailSections, renderField, groupTag, fieldStatusTag } from './field-display.js';

export async function initialize() {
  await loadCatalog();
  const data = await api.get('/api/groups');
  if (loadPrefs().showRemark !== false) {
    try {
      const remarks = await api.get('/api/groups/remarks');
      data.groups.forEach(group => { group.group_remark = remarks.remarks?.[group.group_id] || group.group_remark || ''; });
    } catch (error) { /* 已有资料仍可查看，完整状态在查询和补全界面显示。 */ }
  }
  setGroups(data.groups);
  return data.groups;
}

export async function requestData(path, body, onProgress) {
  let data = await api.post(path, body);
  while (data.pending) {
    const job = await api.pollJob(data.job.id, item => onProgress?.(item));
    if (job.status === 'canceled') throw new Error('资料补全已中止；当前筛选尚未得到完整结果。');
    data = await api.post(path, { ...body, refresh: false });
  }
  if (data.fields) mergeFields(data.fields);
  return data;
}

export function jobBanner(element, job, onFinish) {
  if (!element?.isConnected) return;
  const running = ['pending', 'running'].includes(job.status);
  element.hidden = false;
  element.innerHTML = `<div class="job-strip"><span class="job-strip-dot ${running ? 'busy' : ''}"></span><strong>${esc(job.title)}</strong><span>${job.cursor} / ${job.total} · 成功 ${job.ok} · 失败 ${job.fail}</span><span class="spacer"></span>${running ? '<button class="btn btn-sm" data-cancel-job type="button">中止</button>' : '<a class="btn btn-sm" href="#/tasks">查看任务</a>'}</div>`;
  element.querySelector('[data-cancel-job]')?.addEventListener('click', async () => {
    await api.post(`/api/jobs/${job.id}/cancel`, {}); toast('已请求中止', 'warn');
  });
  if (!running) onFinish?.();
}

export async function collect(groupIds, element, retryFailed = false, onFinish) {
  if (!groupIds.length) { toast('请先选择群', 'warn'); return; }
  try {
    const data = await api.post('/api/data/collect', { group_ids: groupIds, retry_failed: retryFailed });
    await api.pollJob(data.job.id, job => jobBanner(element, job));
    toast('资料采集任务已结束', 'ok', '失败或不支持的接口可在任务中心查看。');
    await onFinish?.();
  } catch (error) { toast(error.message, 'err', error.hint); }
}

export function scopeContext(groupIds, sourceIds = []) {
  return { group_ids: [...groupIds], source_group_ids: [...sourceIds], favorite_ids: loadPrefs().favoriteGroups || [],
    show_remark: loadPrefs().showRemark !== false };
}

export function chooseGroups({ title = '选择群聊范围', selected = [], excluded = [], onApply }) {
  const chosen = new Set(selected.filter(gid => !excluded.includes(gid)));
  let rule = emptyRule(), search = '', seq = 0, list;
  openDrawer({ title, wide: true,
    body: '<div class="picker-intro"><p>勾选需要的群，可以直接拖动滚动条查找；已勾选的群会保留。</p><input class="input" id="scope-search" placeholder="搜索群名称、备注或群号" aria-label="搜索群范围"/></div><div id="scope-filter"></div><div id="scope-progress" hidden></div><div id="scope-results" class="scope-results"></div>',
    footer: '<span class="tiny muted" id="scope-count"></span><button class="btn" id="scope-clear">清空勾选</button><button class="btn" data-close="1">取消</button><button class="btn btn-primary" id="scope-apply">应用群范围</button>',
    onMount(panel, foot) {
      const count = () => { foot.querySelector('#scope-count').textContent = `已选 ${chosen.size} 个群`; };
      const load = async () => {
        const ticket = ++seq;
        const filter = excluded.length ? { op: 'and', rules: [rule, { op: 'not', rules: [{ field: 'group.group_id', op: 'in', value: excluded }] }] } : rule;
        try {
          const data = await requestData('/api/query/start', { entity: 'groups', filter, search, scope: scopeContext([]),
            fields: ['group.display_name','group.group_id','group.member_count','group.my_role'] }, job => jobBanner(panel.querySelector('#scope-progress'), job));
          if (ticket !== seq || !panel.isConnected) return;
          list?.destroy();
          list = new ResultTable(panel.querySelector('#scope-results'), { selected: chosen, layoutKey:'group-picker', onSelection: count, onReload: load });
          list.setData(data, dataColumns(data, { selected: chosen, detail: false }));
        } catch (error) { if (panel.isConnected && ticket === seq) toast(error.message, 'err', error.hint); }
      };
      new FilterBar(panel.querySelector('#scope-filter'), { compact: true, entity: 'groups', onApply(value) { rule = value; load(); } });
      panel.querySelector('#scope-search').addEventListener('change', event => { search = event.target.value.trim(); load(); });
      foot.querySelector('#scope-clear').addEventListener('click', () => { chosen.clear(); count(); list?.schedule(); });
      foot.querySelector('#scope-apply').addEventListener('click', () => { list?.destroy(); closeDrawer(); onApply([...chosen]); });
      count(); load();
    },
  });
}

export async function allResultRows(data) {
  const rows = [...data.items];
  for (let offset = data.items.length; offset < data.total_rows; offset += 200) {
    const next = await api.get(`/api/query/results/${data.query_id}`, { offset, limit: 200 });
    rows.push(...next.items);
  }
  return rows.filter(row => row.kind !== 'group');
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
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `群务资料.${format}`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      list.setLocal(items, dataColumns(data));
    },
  });
}

export function scopeCard(label, ids, button, description = '') {
  const groupNames = names(ids);
  return `<section class="task-scope-card"><div class="task-scope-head"><span>${label}</span><strong>${ids.length} 个群</strong><button class="btn btn-sm" id="${button}">选择群聊</button></div><div class="task-scope-names group-chip-list" title="${esc(groupNames.join('、'))}">${ids.length?ids.map((id,index)=>groupTag(groupNames[index],id)).join(''):'尚未选择群聊'}</div>${description ? `<small>${description}</small>` : ''}</section>`;
}
