import { Virtualizer, observeElementRect, observeElementOffset, elementScroll } from '../vendor/tanstack-virtual-core/index.js';
import * as api from './api.js';
import { esc, fmtNumber } from './ui.js';
import { ResultWindows } from './result-windows.js';
import { state, loadPrefs, savePrefs } from './state.js';
import { canResize, columnWidth, restoreColumns, columnGroups, sortState } from './column-layout.js';
import { groupTag, groupTone, fieldStatusTag, renderField } from './field-display.js';

const HEADER = 44;
export class ResultTable {
  constructor(element, { columns = [], selected, onSelection, onDetail, onSort, sort, onReload, onRowDoubleClick, layoutKey, rowHeight = 56 } = {}) {
    this.element = element;
    this.options = { selected, onSelection, onDetail, onSort, sort, onReload, onRowDoubleClick, rowHeight };
    this.widthKey = `table-columns.${state.session?.login?.user_id || 'local'}.${layoutKey || element.id || 'result'}`;
    this.widths = loadPrefs()[this.widthKey] || {};
    this.columns = columns;
    this.disposed = false;
    element.classList.remove('table-wrap', 'workspace-table');
    element.classList.add('result-table');
    element.classList.toggle('has-row-navigation', Boolean(onRowDoubleClick));
    element.innerHTML = '<div class="result-viewport" tabindex="0" role="table" aria-label="完整结果列表"><div class="result-canvas"><div class="result-head" role="row"></div><div class="result-rows"></div></div></div><div class="result-status" role="status"></div>';
    this.viewport = element.querySelector('.result-viewport');
    this.canvas = element.querySelector('.result-canvas');
    this.head = element.querySelector('.result-head');
    this.body = element.querySelector('.result-rows');
    this.status = element.querySelector('.result-status');
    const common = { getScrollElement: () => this.viewport, observeElementRect, observeElementOffset,
      scrollToFn: elementScroll, onChange: () => this.schedule(),
      initialRect: { width: this.viewport.clientWidth || 900, height: this.viewport.clientHeight || 400 } };
    this.vertical = new Virtualizer({ ...common, count: 0, estimateSize: () => rowHeight, overscan: 8, paddingStart: HEADER });
    this.horizontal = new Virtualizer({ ...common, horizontal: true, count: 0, estimateSize: () => 180, overscan: 2 });
    this.cleanVertical = this.vertical._didMount();
    this.cleanHorizontal = this.horizontal._didMount();
    this.vertical._willUpdate(); this.horizontal._willUpdate();
    this.viewport.addEventListener('change', event => {
      const check = event.target;
      if (check.matches('[data-check-visible]')) {
        this.visibleRows().forEach(row => { if (check.checked) selected.add(row.id); else selected.delete(row.id); });
      } else if (check.matches('[data-row-check]')) {
        if (check.checked) selected.add(check.dataset.rowCheck); else selected.delete(check.dataset.rowCheck);
      } else return;
      onSelection?.(); this.schedule();
    });
    this.viewport.addEventListener('click', event => {
      if (event.target.closest('[data-column-resize]') || this.resizeState) return;
      const sort = event.target.closest('[data-result-sort]');
      const open = event.target.closest('[data-result-open]');
      if (sort) onSort?.(sort.dataset.resultSort);
      if (open) {
        const row = this.visibleRows(true).find(item => item.id === open.dataset.resultOpen);
        if (row) onDetail?.(row, open.dataset.groupId);
      }
    });
    this.viewport.addEventListener('dblclick', event => {
      const handle = event.target.closest('[data-column-resize]');
      if (handle) { event.preventDefault(); this.resetColumn(handle.dataset.columnResize); return; }
      if (event.target.closest('button,input,a,select,textarea,label') || !onRowDoubleClick) return;
      const element = event.target.closest('[data-record-id]');
      const row = element && this.visibleRows(true).find(item => item.id === element.dataset.recordId);
      if (row) { window.getSelection()?.removeAllRanges(); onRowDoubleClick(row); }
    });
    this.viewport.addEventListener('pointerdown', event => {
      const handle = event.target.closest('[data-column-resize]');
      if (!handle || event.button !== 0) return;
      event.preventDefault();
      const column = this.columns.find(item => item.key === handle.dataset.columnResize);
      this.resizeState = { key:column.key, startX:event.clientX, startWidth:column.width, pointerId:event.pointerId };
      this.element.classList.add('is-resizing');
    });
    this.viewport.addEventListener('pointermove', event => {
      if (this.resizeState?.pointerId !== event.pointerId) return;
      // 真正拖动后才捕获指针，让原地双击仍落在列宽手柄上。
      if (Math.abs(event.clientX - this.resizeState.startX) < 2 && !this.viewport.hasPointerCapture(event.pointerId)) return;
      if (!this.viewport.hasPointerCapture(event.pointerId)) this.viewport.setPointerCapture(event.pointerId);
      this.setColumnWidth(this.resizeState.key, this.resizeState.startWidth + event.clientX - this.resizeState.startX);
    });
    for (const event of ['pointerup','pointercancel','lostpointercapture']) this.viewport.addEventListener(event, () => this.finishResize());
    this.viewport.addEventListener('keydown', event => {
      const handle = event.target.closest('[data-column-resize]');
      if (!handle || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const column = this.columns.find(item => item.key === handle.dataset.columnResize);
      const step = event.shiftKey ? 50 : 10;
      const width = event.key === 'Home' ? column.minWidth || 90 : event.key === 'End' ? column.maxWidth || 1000
        : column.width + (event.key === 'ArrowRight' ? step : -step);
      this.setColumnWidth(column.key, width); this.persistColumn(column.key);
    });
    this.status.addEventListener('click', event => {
      if (event.target.closest('[data-result-reload]')) onReload?.();
      if (event.target.closest('[data-result-retry]')) { this.cache.errors.clear(); this.schedule(); }
    });
    // DOM 被替换或抽屉关闭时释放观察器，避免隐藏列表继续请求。
    this.observer = new MutationObserver(() => {
      if (!element.isConnected || element.closest('[aria-hidden="true"]')) this.destroy();
    });
    this.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-hidden'] });
  }

  setData(data, columns = this.columns) {
    this.data = data; this.columns = restoreColumns(columns, this.widths);
    this.cache = new ResultWindows(data, (id, offset, limit) => api.get(`/api/query/results/${id}`, { offset, limit }));
    this.viewport.scrollTop = 0;
    this.vertical.setOptions({ ...this.vertical.options, count: data.total_rows });
    this.reflowColumns();
    this.vertical.measure();
    this.schedule();
  }

  reflowColumns() {
    Object.assign(this, columnGroups(this.columns));
    this.horizontal.setOptions({ ...this.horizontal.options, count: this.rest.length, paddingStart: this.pinnedWidth,
      estimateSize: index => this.rest[index].width });
    this.horizontal.measure();
  }

  setColumnWidth(key, width) {
    const column = this.columns.find(item => item.key === key);
    if (!column || !canResize(column)) return;
    column.width = columnWidth(column, width);
    this.reflowColumns();
    this.schedule();
  }

  persistColumn(key) {
    const column = this.columns.find(item => item.key === key);
    if (!column) return;
    this.widths = { ...(loadPrefs()[this.widthKey] || {}), [key]:column.width };
    savePrefs({ [this.widthKey]:this.widths });
  }

  resetColumn(key) {
    const column = this.columns.find(item => item.key === key);
    if (!column) return;
    this.setColumnWidth(key, column.defaultWidth); this.persistColumn(key);
  }

  finishResize() {
    const drag = this.resizeState;
    if (!drag) return;
    this.resizeState = null; this.persistColumn(drag.key);
    if (this.viewport.hasPointerCapture(drag.pointerId)) this.viewport.releasePointerCapture(drag.pointerId);
    this.element.classList.remove('is-resizing');
  }

  setLocal(items, columns = this.columns) {
    this.setData({ items: items.map((item,index) => ({ ...item, kind: 'record', position: index+1 })), total_rows: items.length, total: items.length, offset: 0 }, columns);
  }

  schedule() {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this.paint(); });
  }

  visibleRows(overscan = false) {
    if (!this.cache) return [];
    const top = this.viewport.scrollTop + HEADER, bottom = this.viewport.scrollTop + this.viewport.clientHeight;
    return this.vertical.getVirtualItems().filter(item => overscan || item.end > top && item.start < bottom)
      .map(item => this.cache.get(item.index)).filter(row => row && row.kind !== 'group');
  }

  paint() {
    if (!this.cache || this.disposed) return;
    const rows = this.vertical.getVirtualItems();
    const width = Math.max(this.viewport.clientWidth, this.horizontal.getTotalSize());
    this.canvas.style.height = `${Math.max(HEADER, this.vertical.getTotalSize())}px`;
    this.canvas.style.width = `${width}px`;
    this.viewport.setAttribute('aria-rowcount', this.data.total_rows + 1);
    const selected = this.options.selected;
    const focused = document.activeElement?.dataset?.rowCheck;
    const focusedHeader = document.activeElement?.matches?.('[data-check-visible]');
    const focusedResize = document.activeElement?.dataset?.columnResize;
    let pinnedLeft = 0;
    const cols = this.pinned.map(col => { const item = { ...col, left: pinnedLeft }; pinnedLeft += col.width; return item; })
      .concat(this.horizontal.getVirtualItems().map(item => ({ ...this.rest[item.index], left: item.start })));
    const cellStyle = col => `width:${col.width}px;left:${col.left}px`;
    this.head.innerHTML = cols.map(col => {
      const sorted = sortState(col.key, this.options.sort);
      const heading = col.header ? col.header() : `<span class="result-heading-label">${esc(col.label)}</span>`;
      const arrow = sorted.active ? `<span class="result-sort-arrow" aria-hidden="true">${sorted.arrow}</span>` : '';
      const resize = canResize(col) ? `<span class="result-resize-handle" data-column-resize="${esc(col.key)}" tabindex="0" role="separator" aria-orientation="vertical" aria-label="调整${esc(col.label)}列宽" aria-valuemin="${col.minWidth || 90}" aria-valuemax="${col.maxWidth || 1000}" aria-valuenow="${col.width}" title="拖动调整列宽；双击恢复默认；方向键微调"></span>` : '';
      return `<div class="result-cell ${col.pinned ? 'result-pinned' : ''} ${sorted.active ? 'result-sorted' : ''} ${canResize(col) ? 'result-resizable' : ''}" style="${cellStyle(col)}" role="columnheader"${this.options.sort ? ` aria-sort="${sorted.aria}"` : ''}>${col.key === '__check'
      ? '<label class="checkbox" title="勾选当前可见记录"><input type="checkbox" data-check-visible aria-label="勾选当前可见记录"/><span></span></label>'
      : this.options.onSort && col.sort !== false ? `<button class="result-sort" data-result-sort="${esc(col.key)}" title="按${esc(col.label)}排序${sorted.active ? `：当前${sorted.label}` : ''}">${heading}${arrow}</button>` : `${heading}${arrow}`}${resize}</div>`;
    }).join('');
    this.body.innerHTML = rows.map(item => {
      const row = this.cache.get(item.index);
      if (!row) return `<div class="result-row result-placeholder" style="top:${item.start}px;height:${item.size}px" role="row"><span>正在读取第 ${fmtNumber(item.index + 1)} 条…</span></div>`;
      if (row.kind === 'group') return `<div class="result-row result-bucket" style="top:${item.start}px;height:${item.size}px" role="row"><strong>${esc(row.label)}</strong><span>${fmtNumber(row.count)} 条</span></div>`;
      return `<div class="result-row ${selected?.has(row.id) ? 'selected' : ''}" data-record-id="${esc(row.id)}"${this.options.onRowDoubleClick ? ' title="双击查看本群成员"' : ''} style="top:${item.start}px;height:${item.size}px" role="row" aria-rowindex="${item.index+2}">
        ${cols.map(col => `<div class="result-cell ${col.pinned ? 'result-pinned' : ''}" style="${cellStyle(col)}" role="cell">${col.key === '__check'
          ? `<label class="checkbox"><input type="checkbox" data-row-check="${esc(row.id)}" ${selected.has(row.id) ? 'checked' : ''} aria-label="勾选 ${esc(row.id)}"/><span></span></label>`
          : col.render ? col.render(row) : `<span title="${esc(row.display?.[col.key])}">${esc(row.display?.[col.key] || '—')}</span>`}</div>`).join('')}</div>`;
    }).join('');
    const visible = this.visibleRows();
    const checkbox = this.head.querySelector('[data-check-visible]');
    if (checkbox) {
      const count = visible.filter(row => selected.has(row.id)).length;
      checkbox.checked = visible.length > 0 && count === visible.length;
      checkbox.indeterminate = count > 0 && count < visible.length;
      checkbox.disabled = !visible.length;
    }
    if (focused) [...this.body.querySelectorAll('[data-row-check]')].find(input => input.dataset.rowCheck === focused)?.focus({ preventScroll: true });
    if (focusedHeader) checkbox?.focus({ preventScroll: true });
    if (focusedResize) [...this.head.querySelectorAll('[data-column-resize]')].find(handle => handle.dataset.columnResize === focusedResize)?.focus({ preventScroll:true });
    if (this.cache.expired) this.status.innerHTML = '查询结果已失效，已加载内容和勾选保留。<button class="btn btn-sm" data-result-reload>重新加载</button>';
    else if (this.cache.errors.size) this.status.innerHTML = `${esc([...this.cache.errors.values()][0].message)} <button class="btn btn-sm" data-result-retry>重试当前窗口</button>`;
    else {
      const timestamp = this.data.data_at || this.data.created_at;
      const at = timestamp ? ` · ${this.data.data_at ? '名单最早时间' : '查询生成'} ${new Date(timestamp*1000).toLocaleString('zh-CN')}${this.data.stale ? ' · 旧缓存，可刷新' : ''}` : '';
      const sort = this.options.sort;
      const label = sort && this.data.fields?.find(field => field.id === sort.field)?.label;
      const order = sort ? ` · ${Object.keys(this.data.buckets || {}).length ? '分组内' : ''}按${label || sort.field}${sort.desc ? '降序' : '升序'}` : '';
      this.status.textContent = (!this.data.total_rows ? '没有匹配记录，可调整范围或条件。' : visible.length
        ? `当前第 ${fmtNumber(visible[0].position)}–${fmtNumber(visible.at(-1).position)} 条／共 ${fmtNumber(this.data.total)} 条${at}`
        : `正在读取当前位置／共 ${fmtNumber(this.data.total)} 条${at}`) + order;
    }
    const cache = this.cache;
    const needed = new Set(rows.filter(item => !cache.get(item.index)).map(item => item.index));
    if (rows.length) needed.add(Math.min(cache.count - 1, rows.at(-1).index + 15));
    needed.forEach(index => {
      if (index >= 0 && !cache.get(index) && !cache.expired && !cache.errors.has(Math.floor(index/200)*200)) {
        cache.request(index).then(() => { if (this.cache === cache) this.schedule(); });
      }
    });
  }

  destroy() {
    if (this.disposed) return;
    this.finishResize();
    this.disposed = true; cancelAnimationFrame(this.frame);
    this.cleanVertical(); this.cleanHorizontal(); this.observer.disconnect();
  }
}

export function dataColumns(data, { selected, matrix = false, matrixField = 'member.card', detail = true, overview = false } = {}) {
  const definitions = new Map(data.fields.map(field => [field.id, field]));
  const groups = new Map(data.groups.map(group => [group.group_id,group.name]));
  const keys = matrix ? ['member.qq', 'member.nickname'] : data.columns;
  const cols = selected ? [{ key: '__check', label: '', width: 40, pinned: true, sort: false }] : [];
  keys.forEach((key, index) => cols.push({ key, label: definitions.get(key)?.label || key, pinned: index < 2,
    width: key.endsWith('.qq') || key.endsWith('.group_id') ? 130 : index === 0 && key.startsWith('group.') ? 260
      : key === 'person.group_names' ? 420 : key.endsWith('_time') ? 205 : key.endsWith('.nickname') ? 180 : 200,
    render: key === 'person.group_names' ? row => `<button class="result-link group-chip-list" data-result-open="${esc(row.id)}" title="${esc(row.display[key])}">${(row.memberships || []).slice(0,2).map((member,index)=>groupTag(groups.get(member.group_id) || row.values[key]?.[index] || member.group_id,member.group_id)).join('')}${(row.memberships?.length || 0)>2 ? `<span class="field-tag field-state-neutral">+${row.memberships.length-2}</span>` : ''}</button>`
      : key === 'person.source_conflict' ? row => row.values[key] ? `<button class="result-link field-tag field-state-warning" data-result-open="${esc(row.id)}">有差异 · 查看</button>` : fieldStatusTag('无冲突','success')
      : row => renderField(row,key) }));
  if (matrix) data.groups.forEach(group => cols.push({ key: `matrix:${group.group_id}`, label: group.name, header:()=>groupTag(group.name,group.group_id), width: 230, sort: false,
    render: row => {
      const membership = row.memberships.find(item => item.group_id === group.group_id);
      return membership ? `<button class="result-link matrix-record group-tone-${groupTone(group.group_id)} ${membership.matched ? 'matched' : ''}" data-result-open="${esc(row.id)}" data-group-id="${esc(group.group_id)}"><span>${esc(membership.display[matrixField] || '（空）')}</span><small>${esc(membership.display['member.role'])}${membership.matched ? ' · 匹配' : ''}</small></button>` : fieldStatusTag('未加入','neutral');
    } }));
  if (detail) cols.push({ key: '__detail', label: '', width: 85, sort: false, render: row => `<button class="btn btn-sm btn-text" data-result-open="${esc(row.id)}">${overview ? '各群资料' : '资料'}</button>` });
  return cols;
}
