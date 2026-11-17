import { esc } from './ui.js';

// 同一个群号始终使用同一种颜色；名称、备注或排序变化不影响它。
export function groupTone(groupId) {
  let hash = 2166136261;
  for (const char of String(groupId)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % 8;
}

export function groupTag(name, groupId) {
  return `<span class="field-tag group-tag group-tone-${groupTone(groupId || name)}" title="${esc(name)}${groupId ? `（${esc(groupId)}）` : ''}">${esc(name)}</span>`;
}

export function fieldStatusTag(label, tone = 'neutral') {
  return `<span class="field-tag field-state-${tone}">${esc(label)}</span>`;
}

export function renderField(row, key, empty = '—') {
  const text = row.display?.[key] ?? '';
  const value = row.values?.[key];
  if (!Object.hasOwn(row.values || {}, key)) {
    const tone = { '采集失败':'danger', '未采集':'pending', '不支持':'neutral', '未提供':'neutral' }[text];
    return text ? fieldStatusTag(text, tone || 'neutral') : esc(empty);
  }
  if (key === 'comparison.status') return fieldStatusTag(text, { missing:'warning',outside:'danger',common:'success' }[value]);
  if (key === 'member.card' && row.values['comparison.status'] === 'missing') return fieldStatusTag('未加入', 'warning');
  if (['group.display_name','group.group_name','group.group_remark'].includes(key) && text) return groupTag(text, row.group_id);
  if (key === 'person.source_group_name' && text) return groupTag(text, row.source_values?.[0]?.group_id || row.person?.source_group_id);
  if (key === 'comparison.source_groups') return value?.length ? `<span class="group-chip-list">${value.map((name,index)=>groupTag(name,row.source_group_ids?.[index])).join('')}</span>` : esc(empty);
  if (['member.role','group.my_role'].includes(key)) return `<span class="tag tag-${['owner','admin','member'].includes(value)?value:'ghost'}">${esc(text)}</span>`;
  if (['member.muted','group.whole_ban','member.unfriendly'].includes(key)) return fieldStatusTag(text, value ? 'warning' : 'success');
  if (key === 'person.in_all') return fieldStatusTag(text, value ? 'success' : 'warning');
  if (typeof value === 'boolean') return fieldStatusTag(text, value ? 'info' : 'neutral');
  return `<span${key === 'member.qq' || key.endsWith('.group_id') ? ' class="mono"' : ''} title="${esc(text)}">${esc(text || empty)}</span>`;
}

const PERSONAL_FIELDS = new Set(['member.qq','member.nickname','member.sex','member.age','member.area','member.qq_level','member.qage','member.is_robot','member.unfriendly']);
export function detailSections(definitions, includeMember) {
  const regular = definitions.filter(field => !field.id.includes('.raw.'));
  const sections = includeMember ? [
    { id:'personal',title:'个人资料',description:'QQ账号本身的信息',fields:regular.filter(field=>PERSONAL_FIELDS.has(field.id)) },
    { id:'membership',title:'在本群的信息',description:'群昵称、身份、等级及活动记录',fields:regular.filter(field=>field.id.startsWith('member.')&&!PERSONAL_FIELDS.has(field.id)) },
  ] : [];
  sections.push({ id:'group',title:'群聊资料',description:'当前群的名称、备注与管理信息',fields:regular.filter(field=>field.id.startsWith('group.')) });
  return sections.filter(section=>section.fields.length);
}
