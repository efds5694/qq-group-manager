import { esc, highlightText, openDrawer } from './ui.js';
import { navigate } from './router.js';
import { groupTone, groupColorStyle } from './group-colors.js';
import { state } from './state.js';
import { GROUP_SEARCH, matchesGroup, mountSearch } from './search-controls.js';
export { groupTone, groupColorStyle } from './group-colors.js';

// 同一个群号始终使用同一种颜色；名称、备注或排序变化不影响它。
export function groupTag(name, groupId, search = '') {
  const id = groupId || name;
  return `<span class="field-tag group-tag group-tone-${groupTone(id)}" style="${groupColorStyle(id)}" title="${esc(name)}${groupId ? `（${esc(groupId)}）` : ''}">${highlightText(name, search)}</span>`;
}

export function groupLink(name, id, search = '') {
  return `<button type="button" class="field-tag group-tag group-link" data-group-link="${esc(id)}"
    style="${groupColorStyle(id)}" title="${esc(name)}（${esc(id)}） · 双击或按 Enter 在群聊目录定位">${highlightText(name, search)}</button>`;
}

export function groupTray(groups, search = '') {
  if (search) {
    const term = search.toLowerCase();
    const startsWithHit = group => Number(group[1].toLowerCase().includes(term));
    groups = [...groups].sort((a, b) => startsWithHit(b) - startsWithHit(a));
  }
  return `<div class="group-chip-list group-chip-tray" data-group-tray="${esc(JSON.stringify(groups))}" data-group-search="${esc(search)}"></div>`;
}

export function fittingTags(widths, measureMore, available, gap = 6) {
  const sum = widths.reduce((total, width, index) => total + width + (index ? gap : 0), 0);
  if (sum <= available) return widths.length;
  let used = 0, fit = 0;
  for (let index = 0; index < widths.length - 1; index++) {
    used += widths[index] + gap;
    if (used + measureMore(widths.length - index - 1) <= available) fit = index + 1;
  }
  return fit;
}

let canvas;
const textWidths = new Map();

export function paintGroupTrays(root) {
  const trays = [...root.querySelectorAll('[data-group-tray]')];
  if (!trays.length) return;
  canvas ||= document.createElement('canvas').getContext('2d');
  const measurements = trays.map(tray => ({tray, width: tray.clientWidth}));
  for (const {tray, width} of measurements) {
    if (!width) continue;
    const groups = JSON.parse(tray.dataset.groupTray);
    const font = '13px ' + getComputedStyle(tray).fontFamily;
    canvas.font = font;
    const measure = text => {
      const key = font + '\0' + text;
      if (!textWidths.has(key)) textWidths.set(key, Math.ceil(canvas.measureText(text).width) + 19);
      return textWidths.get(key);
    };
    const fit = fittingTags(groups.map(([, label]) => measure(label)), count => measure('+' + count), width);
    if (tray.dataset.visible === String(fit)) continue;
    tray.dataset.visible = fit;
    tray.innerHTML = groups.slice(0, fit).map(([id, label]) => groupLink(label, id, tray.dataset.groupSearch)).join('') +
      (fit < groups.length ? `<button class="field-tag field-state-neutral group-more" type="button" data-more-groups
        aria-label="查看全部 ${groups.length} 个群" title="查看全部 ${groups.length} 个群">+${groups.length - fit}</button>` : '');
  }
}

export function observeGroupTrays(root) {
  const observer = new ResizeObserver(() => paintGroupTrays(root));
  observer.observe(root);
  return () => observer.disconnect();
}

function openGroupList(groups) {
  openDrawer({title: `查看全部 ${groups.length} 个群`,
    body: '<div id="group-tray-search"></div><div id="group-tray-list" class="group-tray-drawer"></div>',
    footer: '<button class="btn" data-close="1">关闭</button>',
    onMount(panel) {
      const host = panel.querySelector('#group-tray-list');
      const details = new Map(state.groups.map(group => [group.group_id, group]));
      const update = query => {
        const filtered = groups.filter(([id, label]) => matchesGroup({ ...details.get(id), group_id: id, name: label }, query));
        host.innerHTML = filtered.map(([id, label]) => '<div>' + groupLink(label, id, query) + ' <span class="tiny muted mono">' + highlightText(id, query) + '</span></div>').join('') ||
          '<p class="tiny muted">没有匹配的群聊</p>';
      };
      const search = mountSearch(panel.querySelector('#group-tray-search'), { label: '搜索群聊', placeholder: GROUP_SEARCH, onSubmit: update });
      update('');
      search.focus();
    },
  });
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-more-groups]');
  if (button) openGroupList(JSON.parse(button.closest('[data-group-tray]').dataset.groupTray));
});
function locateGroup(event) {
  const group = event.target.closest('[data-group-link]');
  if (!group) return;
  event.preventDefault();
  navigate('groups', {focus: group.dataset.groupLink});
}
document.addEventListener('dblclick', locateGroup);
document.addEventListener('keydown', event => { if (event.key === 'Enter') locateGroup(event); });

export function fieldStatusTag(label, tone = 'neutral') {
  return `<span class="field-tag field-state-${tone}">${esc(label)}</span>`;
}

export function renderField(row, key, empty = '—', search = '') {
  const text = row.display?.[key] ?? '';
  const value = row.values?.[key];
  if (!Object.hasOwn(row.values || {}, key)) {
    const tone = { '采集失败':'danger', '未采集':'pending', '不支持':'neutral', '未提供':'neutral' }[text];
    return text ? fieldStatusTag(text, tone || 'neutral') : esc(empty);
  }
  if (key === 'comparison.status') return fieldStatusTag(text, { missing:'warning',outside:'danger',common:'success' }[value]);
  if (key === 'member.card' && row.values['comparison.status'] === 'missing') return fieldStatusTag('未加入', 'warning');
  if (['group.display_name','group.group_name','group.group_remark'].includes(key) && text) return groupTag(text, row.group_id, search);
  if (key === 'person.source_group_name' && text) return groupTag(text, row.source_values?.[0]?.group_id || row.person?.source_group_id, search);
  if (key === 'comparison.source_groups') return value?.length ? `<span class="group-chip-list">${value.map((name,index)=>groupTag(name,row.source_group_ids?.[index],search)).join('')}</span>` : esc(empty);
  if (['member.role','group.my_role'].includes(key)) return `<span class="tag tag-${['owner','admin','member'].includes(value)?value:'ghost'}">${esc(text)}</span>`;
  if (['member.muted','group.whole_ban','member.unfriendly'].includes(key)) return fieldStatusTag(text, value ? 'warning' : 'success');
  if (key === 'person.in_all') return fieldStatusTag(text, value ? 'success' : 'warning');
  if (typeof value === 'boolean') return fieldStatusTag(text, value ? 'info' : 'neutral');
  return `<span${key === 'member.qq' || key.endsWith('.group_id') ? ' class="mono"' : ''} title="${esc(text)}">${text ? highlightText(text, search) : esc(empty)}</span>`;
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
