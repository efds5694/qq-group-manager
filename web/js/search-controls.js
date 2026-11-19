import { FilterBar } from './filters.js';
import { groupDisplayName } from './state.js';
import { esc, fmtNumber } from './ui.js';

export const GROUP_SEARCH = '搜索群名、备注或群号';
export const MEMBER_SEARCH = '搜索 QQ号、昵称、群昵称或群名';

export function mountSearch(host, { label, placeholder = label, value = '', onSubmit }) {
  host.innerHTML = `<form class="list-search" role="search" aria-label="${esc(label)}">
    <input type="search" class="input" aria-label="${esc(label)}" placeholder="${esc(placeholder)}" autocomplete="off"/>
    <button class="btn btn-sm" type="submit">搜索</button>
    <button class="btn btn-sm btn-text" type="button" aria-label="清空搜索">清空</button>
  </form>`;
  const form = host.firstElementChild;
  const input = form.querySelector('input');
  const submit = form.querySelector('[type="submit"]');
  const clear = form.querySelector('[type="button"]');
  let applied = value, composing = false;
  const paint = () => { clear.disabled = input.disabled || !(input.value || applied); };
  const setValue = value => { input.value = applied = value; paint(); };
  const apply = () => {
    const next = input.value.trim();
    const previous = applied;
    setValue(next);
    if (next !== previous) onSubmit(next);
  };
  input.addEventListener('input', paint);
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!composing && !input.disabled) apply();
  });
  clear.addEventListener('click', () => { input.value = ''; apply(); input.focus(); });
  setValue(value);
  return {
    setValue,
    focus: () => input.focus(),
    setDisabled(disabled) { input.disabled = submit.disabled = disabled; paint(); },
  };
}

export function mountQueryBar(host, { search, filter, tools = '' }) {
  host.classList.add('query-toolbar');
  host.innerHTML = `<div class="query-search" data-query-search></div>${filter ? '<div data-query-filter></div>' : ''}${tools}`;
  const control = mountSearch(host.querySelector('[data-query-search]'), search);
  const filterHost = host.querySelector('[data-query-filter]');
  if (filterHost) new FilterBar(filterHost, { menu: true, ...filter });
  return {
    search: control,
    setSuspended(suspended) {
      control.setDisabled(suspended);
      if (filterHost) filterHost.hidden = suspended;
    },
  };
}

export function mountChoices(host, { label, onChange }) {
  host.classList.add('view-tabs', 'query-choices');
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', label);
  let value;
  const setValue = next => {
    value = next;
    for (const button of host.querySelectorAll('[data-choice]')) {
      const active = button.dataset.choice === value;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  };
  host.addEventListener('click', event => {
    const button = event.target.closest('[data-choice]');
    if (!button || button.dataset.choice === value) return;
    setValue(button.dataset.choice);
    onChange(value);
  });
  return {
    setValue,
    setChoices(choices, next) {
      host.innerHTML = choices.map(([id, label]) => `<button type="button" data-choice="${esc(id)}">${esc(label)}</button>`).join('');
      setValue(next);
    },
  };
}

export function matchesGroup(group, search) {
  const term = search.toLowerCase();
  return !term || [group.group_id, group.group_name, group.group_remark, group.name]
    .some(value => String(value ?? '').toLowerCase().includes(term));
}

export function mountGroupSelect(host, { groups, label, value = '', onChange }) {
  host.classList.add('group-select');
  host.innerHTML = `<div class="group-select-tools"><div data-group-search></div><span class="tiny muted" role="status" data-group-count></span></div>
    <label>${esc(label)}<select class="input" data-group-select></select></label>`;
  const select = host.querySelector('[data-group-select]');
  const count = host.querySelector('[data-group-count]');
  let term = '';
  const paint = () => {
    const matching = groups.filter(group => matchesGroup(group, term));
    const chosen = groups.find(group => group.group_id === value);
    const options = chosen && !matching.includes(chosen) ? [chosen, ...matching] : matching;
    select.innerHTML = `<option value="">${options.length ? '请选择群聊' : '没有匹配的群聊'}</option>` +
      options.map(group => `<option value="${esc(group.group_id)}">${esc(groupDisplayName(group))}（${esc(group.group_id)}）</option>`).join('');
    select.value = chosen ? value : '';
    count.textContent = term ? `匹配 ${fmtNumber(matching.length)} 个群` : `共 ${fmtNumber(groups.length)} 个群`;
  };
  const search = mountSearch(host.querySelector('[data-group-search]'), {
    label: `搜索${label}`, placeholder: GROUP_SEARCH, onSubmit(next) { term = next; paint(); },
  });
  select.addEventListener('change', () => { value = select.value; onChange(value); });
  paint();
  return {
    get value() { return select.value; },
    setDisabled(disabled) { select.disabled = disabled; search.setDisabled(disabled); },
    setValue(next) { value = next; paint(); },
    setGroups(next) {
      const previous = select.value;
      groups = next;
      paint();
      if (previous && !select.value) { value = ''; onChange(''); }
    },
  };
}
