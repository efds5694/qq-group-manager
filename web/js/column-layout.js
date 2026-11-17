// 表格列宽的统一规则；数据列可调整，选择框和操作列保持固定。
export const canResize = column => column.resizable !== false && !column.key.startsWith('__');

export function columnWidth(column, width) {
  const fallback = column.defaultWidth ?? column.width;
  if (!canResize(column)) return fallback;
  const value = typeof width === 'number' && Number.isFinite(width) ? width : fallback;
  return Math.round(Math.max(column.minWidth || 90, Math.min(column.maxWidth || 1000, value)));
}

export function restoreColumns(columns, widths) {
  return columns.map(column => ({ ...column, defaultWidth: column.defaultWidth ?? column.width,
    width: columnWidth(column, widths[column.key]) }));
}

export function columnGroups(columns) {
  const pinned = columns.filter(column => column.pinned);
  return { pinned, rest: columns.filter(column => !column.pinned), pinnedWidth: pinned.reduce((sum,column) => sum+column.width,0) };
}

export function sortState(key, sort) {
  const active = Boolean(sort?.field && sort.field === key);
  return { active, aria: active ? sort.desc ? 'descending' : 'ascending' : 'none',
    arrow: active ? sort.desc ? '↓' : '↑' : '', label: active ? sort.desc ? '降序' : '升序' : '' };
}
