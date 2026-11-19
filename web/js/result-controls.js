import { actionMenu, esc, fmtNumber } from './ui.js';
import { fieldSelectOptions } from './filters.js';
import { state } from './state.js';
import { exportData } from './workspace.js';

export function operationRange(selected, override) {
  return selected.size && override !== 'filtered' ? 'selected' : 'filtered';
}

export async function resolveOperationIds(table, selected, isCurrent) {
  const ids = selected ?? await table.loadSelectionIds();
  return isCurrent() ? ids : null;
}

export function mountResultActions(host, { selected, onClear, progress, tools = '' }) {
  const formats = state.config?.formats || ['csv'];
  host.classList.add('workspace-toolbar', 'result-actions');
  host.innerHTML = `<div class="result-scope">
    <span class="result-counts tiny muted" role="status"></span>
    <label class="result-range"><span>操作范围</span><select class="input operation-range">
      <option value="filtered">全部筛选结果</option><option value="selected">仅勾选记录</option>
    </select></label><button class="btn btn-sm btn-text" type="button" data-clear-selection>取消勾选</button>
    </div><div class="result-action-buttons">${tools}
    ${actionMenu('导出', `<button class="btn btn-sm" type="button" data-copy-results>复制表格</button>
      <label>文件格式<select class="input" data-export-format>${formats.map(format => `<option value="${esc(format)}">${esc(format.toUpperCase())}</option>`).join('')}</select></label>
      <button class="btn btn-sm btn-primary" type="button" data-export-results>导出文件</button>`)}
    </div>`;
  const range = host.querySelector('.operation-range');
  const counts = host.querySelector('.result-counts');
  const clear = host.querySelector('[data-clear-selection]');
  const copy = host.querySelector('[data-copy-results]');
  const exportFile = host.querySelector('[data-export-results]');
  const format = host.querySelector('[data-export-format]');
  let options = {}, override;
  const activeRange = () => operationRange(selected, options.locked ? undefined : override);
  const selectedIds = () => activeRange() === 'selected' ? [...selected] : undefined;
  const usable = () => options.ready && !options.busy && Boolean(options.data?.total);
  const paint = () => {
    const { data, ready, busy, unit = '条记录', label, locked } = options;
    counts.textContent = data
      ? `${!ready && !busy ? '上次结果 · ' : ''}${label || `${fmtNumber(data.total)} ${unit}`} · 已勾选 ${fmtNumber(selected.size)} ${unit}`
      : busy ? '读取中…' : '暂无结果';
    range.value = activeRange();
    range.options[1].disabled = !selected.size;
    range.disabled = !usable() || Boolean(locked);
    clear.disabled = busy || !selected.size;
    copy.disabled = exportFile.disabled = !usable();
  };
  const exportResult = fileFormat => {
    if (usable()) exportData({ query_id: options.data.query_id, selected: selectedIds() }, fileFormat, progress);
  };
  range.addEventListener('change', () => { override = range.value; paint(); });
  clear.addEventListener('click', onClear);
  copy.addEventListener('click', () => exportResult('tsv'));
  exportFile.addEventListener('click', () => exportResult(format.value));
  return {
    resetRange() { override = undefined; },
    selectedIds,
    usable,
    update(next) { options = next; if (!selected.size) override = undefined; paint(); },
    resolveIds(table) {
      if (!usable()) return Promise.resolve(null);
      const { data } = options;
      return resolveOperationIds(table, selectedIds(), () => usable() && options.data === data && !table.disposed);
    },
  };
}

export function mountDisplayOptions(host, { groupBy, chooseColumns, onGroup, extra = '' }) {
  host.innerHTML = actionMenu('显示', `${extra}<button class="btn btn-sm" data-display-columns>选择显示字段…</button>
    <label>分组字段<select class="input" data-display-field><option value="">不分组</option>${fieldSelectOptions(groupBy.field)}</select></label>
    <details><summary>高级分组</summary><label>提取分组的正则<input class="input mono" data-display-pattern value="${esc(groupBy.pattern || '')}" placeholder="可选"/></label></details>
    <button class="btn btn-sm" data-display-group>应用分组</button>`, 'display-options');
  const columns = host.querySelector('[data-display-columns]');
  const field = host.querySelector('[data-display-field]');
  const pattern = host.querySelector('[data-display-pattern]');
  field.value = groupBy.field || '';
  columns.addEventListener('click', chooseColumns);
  host.querySelector('[data-display-group]').addEventListener('click', () => {
    onGroup({ field: field.value, pattern: pattern.value });
  });
  return { setColumnsVisible(visible) { columns.hidden = !visible; } };
}
