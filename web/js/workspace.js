// 桌面工作台共用查询、群选择、列选择、资料详情与导出。
import * as api from './api.js';
import { state, setGroups, loadPrefs, groupDisplayName } from './state.js';
import { esc, openDrawer, closeDrawer, toast, copyText, fmtNumber } from './ui.js';
import { FilterBar, catalog, loadCatalog, mergeFields, clone, emptyRule } from './filters.js';
import { bindAutoPage } from './pagination.js';

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

export async function allRows(spec) {
  const first = await requestData('/api/query', { ...spec, page: 1, size: 500 });
  const items = [...first.items];
  for (let page = 2; page <= first.pages; page++) {
    const data = await requestData('/api/query', { ...spec, page, size: 500 });
    items.push(...data.items);
  }
  return items;
}

export function chooseGroups({ title = '选择群聊范围', selected = [], excluded = [], onApply }) {
  const chosen = new Set(selected);
  let rule = emptyRule();
  let page = 1;
  let search = '';
  let seq = 0;
  let data = null;
  let loading = false;
  openDrawer({ title, wide: true,
    body: '<div class="picker-intro"><p>使用同一套筛选条件查找群；勾选可跨页累积，列表触底自动下一页。</p><input class="input" id="scope-search" placeholder="搜索群名称、备注或群号" aria-label="搜索群范围"/></div><div id="scope-filter"></div><div id="scope-progress" hidden></div><div id="scope-results" class="scope-results"></div>',
    footer: `<span class="tiny muted" id="scope-count"></span><button class="btn" id="scope-clear" type="button">清空勾选</button><button class="btn" data-close="1" type="button">取消</button><button class="btn btn-primary" id="scope-apply" type="button">应用群范围</button>`,
    onMount(panel, foot) {
      const count = () => { foot.querySelector('#scope-count').textContent = `已选 ${chosen.size} 个群`; };
      const results = panel.querySelector('#scope-results');
      const load = async () => {
        const ticket = ++seq;
        loading = true; data = null; results.scrollTop = 0;
        results.innerHTML = '<div class="skeleton" style="height:160px"></div>';
        try {
          const response = await requestData('/api/query', { entity: 'groups', filter: rule, search, page, scope: scopeContext([]) }, job => jobBanner(panel.querySelector('#scope-progress'), job));
          if (ticket !== seq || !panel.isConnected) return;
          data = response; page = data.page;
          results.innerHTML = `<div class="scope-list">${data.items.filter(row => !excluded.includes(row.id)).map(row => `<label class="scope-pick-row"><span class="checkbox"><input type="checkbox" value="${esc(row.id)}" ${chosen.has(row.id) ? 'checked' : ''}/><span></span></span><span class="scope-pick-name"><strong>${esc(row.display['group.display_name'])}</strong><span>${esc(row.display['group.group_id'])} · ${esc(row.display['group.member_count'])} 人 · ${esc(row.display['group.my_role'])}</span></span></label>`).join('') || '<div class="empty"><strong>没有匹配的群</strong><p>调整筛选条件后再试。</p></div>'}</div><div class="picker-pager"><button class="btn btn-sm" data-page="-1" ${page <= 1 ? 'disabled' : ''}>上一页</button><span class="tiny muted">${page} / ${data.pages} 页 · ${fmtNumber(data.total)} 个群</span><button class="btn btn-sm" data-page="1" ${page >= data.pages ? 'disabled' : ''}>下一页</button></div>`;
          results.querySelectorAll('input[type=checkbox]').forEach(check => check.addEventListener('change', () => {
            if (check.checked) chosen.add(check.value); else chosen.delete(check.value); count();
          }));
          results.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => changePage(page + Number(button.dataset.page))));
          return true;
        } catch (error) { if (panel.isConnected && ticket === seq) results.innerHTML = errorBox(error); return false; }
        finally { if (ticket === seq) loading = false; }
      };
      const changePage = async next => {
        if (loading || !data || next < 1 || next > data.pages) return;
        const previous = page;
        page = next;
        if (await load() === false) page = previous;
      };
      bindAutoPage(results, () => !loading && data && page < data.pages, () => changePage(page + 1));
      new FilterBar(panel.querySelector('#scope-filter'), { compact: true, entity: 'groups', onApply(value) { rule = value; page = 1; load(); } });
      panel.querySelector('#scope-search').addEventListener('change', event => { search = event.target.value.trim(); page = 1; load(); });
      foot.querySelector('#scope-clear').addEventListener('click', () => { chosen.clear(); count(); load(); });
      foot.querySelector('#scope-apply').addEventListener('click', () => { closeDrawer(); onApply([...chosen]); });
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
        panel.querySelector('#column-list').innerHTML = catalog.fields.filter(field => (entity !== 'groups' || field.id.startsWith('group.')) && `${field.label} ${field.id}`.toLowerCase().includes(text.toLowerCase())).map(field => `<label class="column-option"><input type="checkbox" value="${esc(field.id)}" ${selected.has(field.id) || mandatory.includes(field.id) ? 'checked' : ''} ${mandatory.includes(field.id) ? 'disabled' : ''}/><span><strong>${esc(field.label)}</strong><span class="tiny faint">${esc(field.source)} · ${esc(field.type)}</span></span></label>`).join('');
      };
      panel.querySelector('#column-list').addEventListener('change', event => { if (event.target.checked) selected.add(event.target.value); else selected.delete(event.target.value); });
      panel.querySelector('#column-search').addEventListener('input', event => paint(event.target.value));
      foot.querySelector('#columns-apply').addEventListener('click', () => { closeDrawer(); onApply([...new Set([...mandatory, ...selected])]); });
      paint();
    },
  });
}

export function tableHtml(data, selected = new Set(), { matrix = false, matrixField = 'member.card' } = {}) {
  const definitions = new Map(catalog.fields.map(field => [field.id, field]));
  const identity = matrix ? ['member.qq', 'member.nickname'] : data.columns;
  return `<table class="table data-table ${data.columns[0]?.startsWith('group.') ? 'group-data-table' : 'member-data-table'} ${matrix ? 'matrix-table' : ''}"><thead><tr><th class="identity-check"><span class="checkbox"><input type="checkbox" data-check-page aria-label="勾选当前页所有记录"/><span></span></span></th>
    ${identity.map((key, index) => `<th class="${index === 0 ? 'identity-main' : index === 1 ? 'identity-secondary' : ''}" data-sort="${esc(key)}">${esc(definitions.get(key)?.label || key)}</th>`).join('')}
    ${matrix ? `<th>基准群昵称</th>${data.groups.map(group => `<th class="matrix-group-head" title="${esc(group.group_id)}"><span>${esc(group.name)}</span><small>${esc(group.group_id)}</small></th>`).join('')}` : ''}<th class="row-action-head"></th></tr></thead><tbody>
    ${data.items.map((row, index) => {
      const memberships = new Map((row.memberships || []).map(member => [member.group_id, member]));
      const bucket = row.bucket !== undefined && (index === 0 || row.bucket !== data.items[index-1].bucket)
        ? `<tr class="bucket-row"><td colspan="${identity.length + (matrix ? data.groups.length + 1 : 0) + 2}">${esc(row.bucket)} <span>${data.buckets?.[row.bucket] || ''} 条</span></td></tr>` : '';
      return `${bucket}<tr data-row="${esc(row.id)}" class="${selected.has(row.id) ? 'selected' : ''}"><td class="identity-check"><span class="checkbox"><input type="checkbox" data-check-row value="${esc(row.id)}" ${selected.has(row.id) ? 'checked' : ''} aria-label="勾选 ${esc(row.id)}"/><span></span></span></td>
        ${identity.map((key, index) => `<td class="${index === 0 ? 'identity-main' : index === 1 ? 'identity-secondary' : ''} ${key.endsWith('.qq') || key.endsWith('.group_id') ? 'mono' : ''}" title="${esc(row.display[key])}">${['member.role', 'group.my_role'].includes(key) ? `<span class="tag tag-${esc(row.values[key] || 'ghost')}">${esc(row.display[key])}</span>` : esc(row.display[key] || '—')}</td>`).join('')}
        ${matrix ? `<td class="reference-cell" title="${esc(row.person.reference_card)}">${esc(row.person.reference_card || '无基准昵称')}${row.person.source_conflict ? '<small class="text-warn">来源有差异</small>' : ''}</td>${data.groups.map(group => {
          const membership = memberships.get(group.group_id);
          return membership ? `<td class="matrix-present ${membership.matched ? 'matrix-matched' : ''}"><button class="cell-detail" data-detail="${esc(row.id)}" data-gid="${esc(group.group_id)}" title="${esc(membership.display[matrixField])}"><span>${esc(membership.display[matrixField] || '（空）')}</span><small>${esc(membership.display['member.role'])}${membership.matched ? ' · 匹配' : ''}</small></button></td>` : '<td class="matrix-absent">未加入</td>';
        }).join('')}` : ''}
        <td><button class="btn btn-sm btn-text" data-detail="${esc(row.id)}" type="button">资料</button></td></tr>`;
    }).join('') || `<tr><td colspan="${identity.length + (matrix ? data.groups.length + 1 : 0) + 2}"><div class="empty"><strong>没有匹配的记录</strong><p>调整范围或条件后再试。</p></div></td></tr>`}
    </tbody></table>`;
}

export function bindTable(element, data, selected, onSelection, onSort, onDetail) {
  const pageCheck = element.querySelector('[data-check-page]');
  const update = () => {
    const checks = [...element.querySelectorAll('[data-check-row]')];
    checks.forEach(check => { check.checked = selected.has(check.value); check.closest('tr').classList.toggle('selected', check.checked); });
    const count = checks.filter(check => check.checked).length;
    if (pageCheck) { pageCheck.checked = checks.length > 0 && count === checks.length; pageCheck.indeterminate = count > 0 && count < checks.length; }
    onSelection?.();
  };
  element.querySelectorAll('[data-check-row]').forEach(check => check.addEventListener('change', () => { if (check.checked) selected.add(check.value); else selected.delete(check.value); update(); }));
  pageCheck?.addEventListener('change', () => { data.items.forEach(row => { if (pageCheck.checked) selected.add(row.id); else selected.delete(row.id); }); update(); });
  element.querySelectorAll('[data-sort]').forEach(cell => cell.addEventListener('click', () => onSort?.(cell.dataset.sort)));
  element.querySelectorAll('[data-detail]').forEach(button => button.addEventListener('click', () => onDetail?.(data.items.find(row => row.id === button.dataset.detail), button.dataset.gid)));
  update();
}

export async function showDetails(spec, row, gid) {
  const actualGid = gid || row.group_id;
  const body = { ...clone(spec), entity: row.qq ? 'memberships' : 'groups', filter: emptyRule(), search: '', details: true,
    selected: [row.qq ? `${actualGid}:${row.qq}` : row.id], fields: catalog.fields.map(field => field.id), page: 1 };
  openDrawer({ title: row.qq ? `成员资料 · ${row.qq}` : `群聊资料 · ${row.id}`, wide: true,
    body: '<div class="skeleton" style="height:180px"></div>', footer: '<button class="btn" data-close="1">关闭</button>',
    onMount: async panel => {
      try {
        const data = await requestData('/api/query', body);
        const item = data.items[0];
        if (!item || !panel.isConnected) return;
        const relevant = catalog.fields.filter(field => field.id.startsWith('group.') || (row.qq && field.id.startsWith('member.')));
        panel.innerHTML = `<p class="tiny muted">常用字段来自资料归一化，扩展字段按原接口保存。显示“未采集”的字段可在工作台补全资料。</p><dl class="record-details">${relevant.filter(field => !field.id.includes('.raw.')).map(field => `<div><dt>${esc(field.label)}</dt><dd>${esc(item.display[field.id] || '（空）')}</dd></div>`).join('')}</dl>
          <details class="raw-details"><summary>完整原始资料与接口状态</summary><pre>${esc(JSON.stringify(item.raw, null, 2))}</pre></details>`;
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
