// 共享条件编辑器；群目录、成员工作台和群选择器均使用此组件。
import * as api from './api.js';
import { esc, toast } from './ui.js';

export const emptyRule = () => ({ op: 'and', rules: [] });
export let catalog = { fields: [], operators: {}, presets: [], group_presets: [] };
export const clone = value => JSON.parse(JSON.stringify(value));
export const REGEX_HELP_URL = 'https://docs.python.org/zh-cn/3/howto/regex.html';
export const regexHelpLink = () => `<a class="regex-help" href="${REGEX_HELP_URL}" target="_blank" rel="noopener noreferrer">正则帮助 ↗</a>`;

function updatePresets(data) {
  catalog.presets = data.presets;
  catalog.group_presets = data.group_presets;
  document.querySelectorAll('.filter-presets').forEach(select => select.dispatchEvent(new Event('presetsupdated')));
}

export async function loadCatalog(force = false) {
  if (catalog.fields.length && !force) return catalog;
  const [fields, presets] = await Promise.all([api.get('/api/fields'), api.get('/api/filter-presets')]);
  catalog = { ...fields, ...presets };
  return catalog;
}

export function mergeFields(fields) {
  const map = new Map(catalog.fields.map(field => [field.id, field]));
  fields.forEach(field => map.set(field.id, field));
  catalog.fields = [...map.values()];
}

export function summary(rule) {
  if (rule.rules) {
    if (!rule.rules.length) return '全部记录';
    const joined = rule.rules.map(summary).join(rule.op === 'or' ? ' 或 ' : ' 且 ');
    return rule.op === 'not' ? `非（${joined}）` : joined;
  }
  if (rule.relation) {
    const labels = { any: '任一', all: '全部', none: '没有', count: `数量 ${rule.compare || 'gte'} ${rule.value ?? 1}` };
    return `${rule.relation === 'members' ? '群内成员' : '同一人的群记录'}：${labels[rule.quantifier || 'any']}（${summary(rule.where || emptyRule())}）`;
  }
  const label = catalog.fields.find(field => field.id === rule.field)?.label || rule.field;
  const value = Array.isArray(rule.value) ? rule.value.join('，') : String(rule.value ?? '');
  return `${label} ${catalog.operators[rule.op] || rule.op} ${['empty', 'missing', 'exists'].includes(rule.op) ? '' : value}`.trim();
}

function fieldOptions(current) {
  const categories = [['群聊资料', 'group.'], ['成员资料', 'member.'], ['跨群计算', 'person.']];
  return categories.map(([label, prefix]) => `<optgroup label="${label}">${catalog.fields.filter(field => field.id.startsWith(prefix) && !field.id.includes('.raw.')).map(field => `<option value="${esc(field.id)}" ${field.id === current ? 'selected' : ''}>${esc(field.label)}</option>`).join('')}</optgroup>`).join('') +
    `<optgroup label="扩展原始字段">${catalog.fields.filter(field => field.id.includes('.raw.')).map(field => `<option value="${esc(field.id)}" ${field.id === current ? 'selected' : ''}>${esc(field.id)}</option>`).join('')}${current && !catalog.fields.some(field => field.id === current) ? `<option selected value="${esc(current)}">${esc(current)}</option>` : ''}</optgroup>`;
}

function valueEditor(rule, path) {
  const field = catalog.fields.find(field => field.id === rule.field) || {};
  const unary = ['empty', 'missing', 'exists'].includes(rule.op);
  if (unary) return '<span class="condition-unary">无需填写值</span>';
  const val = Array.isArray(rule.value) ? rule.value.join(',') : String(rule.value ?? '');
  if (['eq', 'ne'].includes(rule.op) && (field.type === 'boolean' || field.type === 'enum')) {
    const values = field.type === 'boolean' ? [['true', '是'], ['false', '否']] : field.values.map(value => [value, ({ owner: '群主', admin: '管理员', member: '成员', male: '男', female: '女', unknown: '未知' })[value] || value]);
    return `<select class="input" data-rule-path="${path}" data-prop="value">${values.map(([value, label]) => `<option value="${value}" ${String(rule.value) === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
  }
  return `<input class="input condition-value" data-rule-path="${path}" data-prop="value" value="${esc(val)}" placeholder="${rule.op === 'between' ? '开始值,结束值' : rule.op === 'field_ne' ? '另一字段标识' : ['within_days', 'older_days'].includes(rule.op) ? '天数' : '条件值'}" aria-label="条件值" />`;
}

function renderRule(rule, path = '') {
  const encoded = esc(path);
  const remove = path ? `<button class="icon-btn" data-remove-rule="${encoded}" title="删除此条件" type="button">×</button>` : '';
  if (rule.rules) {
    return `<div class="condition-group"><div class="condition-group-head"><select class="input condition-join" data-rule-path="${encoded}" data-prop="op"><option value="and" ${rule.op === 'and' ? 'selected' : ''}>全部满足（并且）</option><option value="or" ${rule.op === 'or' ? 'selected' : ''}>任一满足（或者）</option><option value="not" ${rule.op === 'not' ? 'selected' : ''}>均不满足（非）</option></select>
      <span class="spacer"></span><button class="btn btn-sm" data-add-rule="${encoded}" data-kind="leaf" type="button">＋ 条件</button><button class="btn btn-sm" data-add-rule="${encoded}" data-kind="group" type="button">＋ 条件组</button><button class="btn btn-sm" data-add-rule="${encoded}" data-kind="relation" type="button">＋ 成员关系</button>${remove}</div>
      <div class="condition-children">${rule.rules.map((child, index) => renderRule(child, `${path}${path ? '.' : ''}rules.${index}`)).join('') || '<p class="condition-empty">未添加条件，显示范围内全部记录。</p>'}</div></div>`;
  }
  if (rule.relation) {
    return `<div class="condition-relation"><div class="condition-row"><select class="input" data-rule-path="${encoded}" data-prop="relation"><option value="memberships" ${rule.relation === 'memberships' ? 'selected' : ''}>同一个人的群记录</option><option value="members" ${rule.relation === 'members' ? 'selected' : ''}>这个群的成员</option></select>
      <select class="input" data-rule-path="${encoded}" data-prop="quantifier">${[['any', '任一记录满足'], ['all', '全部记录满足'], ['none', '没有记录满足'], ['count', '匹配数量']].map(([value, label]) => `<option value="${value}" ${rule.quantifier === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
      ${rule.quantifier === 'count' ? `<select class="input condition-compare" data-rule-path="${encoded}" data-prop="compare">${[['gte', '≥'], ['gt', '>'], ['eq', '='], ['ne', '≠'], ['lte', '≤'], ['lt', '<']].map(([value, label]) => `<option value="${value}" ${(rule.compare || 'gte') === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select><input class="input condition-count" type="number" min="0" value="${Number(rule.value ?? 1)}" data-rule-path="${encoded}" data-prop="value" aria-label="匹配数量"/>` : ''}${remove}</div>
      ${renderRule(rule.where || emptyRule(), `${path}${path ? '.' : ''}where`)}</div>`;
  }
  return `<div class="condition-row"><select class="input condition-field" data-rule-path="${encoded}" data-prop="field" aria-label="筛选字段">${fieldOptions(rule.field)}</select>
    <select class="input condition-operator" data-rule-path="${encoded}" data-prop="op" aria-label="匹配方式">${Object.entries(catalog.operators).map(([value, label]) => `<option value="${value}" ${rule.op === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>
    ${valueEditor(rule, encoded)}${['regex', 'not_regex'].includes(rule.op) ? `<input class="input condition-flags" data-rule-path="${encoded}" data-prop="flags" value="${esc(rule.flags || '')}" placeholder="ims" title="i 忽略大小写；m 多行；s 跨行" aria-label="正则标记"/>` : ''}${remove}</div>`;
}

export class FilterBar {
  constructor(element, { rule, onApply, compact = false, entity = 'memberships' } = {}) {
    this.element = element;
    this.rule = clone(rule || emptyRule());
    this.draft = clone(this.rule);
    this.onApply = onApply;
    this.compact = compact;
    this.entity = entity;
    this.selectedPreset = '';
    this.temporary = false;
    this.paint();
  }

  get(path) {
    return path ? path.split('.').reduce((obj, key) => obj[key], this.draft) : this.draft;
  }

  options() {
    return `<option value="" ${!this.selectedPreset || this.temporary ? 'selected' : ''}>临时筛选／选择预设</option>` + ['builtin', 'custom'].map(kind => `<optgroup label="${kind === 'builtin' ? '内置筛选' : '自定义筛选'}">${this.presets().filter(item => Boolean(item.builtin) === (kind === 'builtin')).map(item => `<option value="${esc(item.id)}" ${!this.temporary && this.selectedPreset === item.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</optgroup>`).join('');
  }

  presets() { return this.entity === 'groups' ? catalog.group_presets : catalog.presets; }

  markTemporary() {
    this.temporary = true;
    this.element.querySelector('.filter-presets').value = '';
  }

  paint() {
    this.element.innerHTML = `<div class="filter-bar"><select class="input filter-presets" aria-label="共享筛选预设">${this.options()}</select><button class="btn filter-toggle" type="button">编辑条件</button>${regexHelpLink()}
      <span class="filter-summary" title="${esc(summary(this.rule))}">${esc(summary(this.rule))}</span><button class="btn btn-text filter-clear" type="button">清除</button></div>
      <div class="filter-editor" hidden><div class="filter-rule-tree"></div><p class="tiny faint">同一关系组内的条件由同一条记录满足。正则使用 Python 语法；日期按北京时间，范围值用逗号分隔。</p>
      <div class="filter-editor-actions"><button class="btn btn-primary filter-apply" type="button">应用条件</button><button class="btn filter-save-toggle" type="button">保存为下拉预设</button><span class="spacer"></span><button class="btn btn-text filter-delete" type="button">删除此预设</button></div>
      <div class="filter-save-form" hidden><input class="input" placeholder="预设名称" aria-label="预设名称"/><button class="btn filter-save-new" type="button">另存为新预设</button><button class="btn filter-save-existing" type="button">更新此预设</button></div><p class="filter-error" role="alert"></p></div>`;
    this.tree = this.element.querySelector('.filter-rule-tree');
    this.editor = this.element.querySelector('.filter-editor');
    this.paintTree();
    this.element.querySelector('.filter-toggle').addEventListener('click', () => { this.editor.hidden = !this.editor.hidden; });
    const select = this.element.querySelector('.filter-presets');
    select.addEventListener('presetsupdated', () => { select.innerHTML = this.options(); });
    select.addEventListener('change', () => {
      this.selectedPreset = select.value;
      this.temporary = false;
      const preset = this.presets().find(item => item.id === select.value);
      if (!preset) return;
      this.draft = clone(preset.rule);
      this.paintTree();
      if (preset.parameterized) this.editor.hidden = false;
      else this.apply();
    });
    this.element.querySelector('.filter-clear').addEventListener('click', () => {
      this.selectedPreset = ''; this.temporary = false; this.draft = emptyRule(); select.value = ''; this.paintTree(); this.apply();
    });
    this.element.querySelector('.filter-apply').addEventListener('click', () => this.apply());
    this.element.querySelector('.filter-save-toggle').addEventListener('click', () => {
      const form = this.element.querySelector('.filter-save-form');
      form.hidden = !form.hidden;
      form.querySelector('input').value = this.presets().find(item => item.id === this.selectedPreset)?.name || '';
    });
    this.element.querySelector('.filter-save-new').addEventListener('click', () => this.save(false));
    this.element.querySelector('.filter-save-existing').addEventListener('click', () => this.save(true));
    this.element.querySelector('.filter-delete').addEventListener('click', async () => {
      if (!this.selectedPreset || this.selectedPreset.startsWith('builtin-')) { this.error('请选择自定义预设；内置预设可复制后修改。'); return; }
      try {
        const data = await api.del(`/api/filter-presets/${this.selectedPreset}`);
        this.selectedPreset = ''; this.temporary = true; updatePresets(data); toast('已删除自定义筛选预设', 'ok');
      } catch (error) { this.error(error.message); }
    });
    this.tree.addEventListener('change', event => {
      const input = event.target;
      if (!input.matches('[data-rule-path]')) return;
      this.markTemporary();
      const rule = this.get(input.dataset.rulePath);
      const prop = input.dataset.prop;
      rule[prop] = input.value;
      if (prop === 'field') {
        const definition = catalog.fields.find(item => item.id === input.value);
        rule.value = definition?.type === 'boolean' ? true : definition?.values?.[0] || '';
      }
      if (prop === 'op' && ['eq', 'ne'].includes(input.value)) {
        const definition = catalog.fields.find(field => field.id === rule.field);
        if (definition?.type === 'boolean') rule.value = true;
        else if (definition?.values?.length && !definition.values.includes(rule.value)) rule.value = definition.values[0];
      }
      if (prop === 'field' || prop === 'op' || prop === 'quantifier' || prop === 'relation') this.paintTree();
    });
    this.tree.addEventListener('input', event => {
      const input = event.target;
      if (input.matches('input[data-rule-path]')) { this.markTemporary(); this.get(input.dataset.rulePath)[input.dataset.prop] = input.value; }
    });
    this.tree.addEventListener('click', event => {
      const add = event.target.closest('[data-add-rule]');
      const remove = event.target.closest('[data-remove-rule]');
      if (add) {
        this.markTemporary();
        const group = this.get(add.dataset.addRule);
        const child = add.dataset.kind === 'group' ? emptyRule() : add.dataset.kind === 'relation'
          ? { relation: this.entity === 'groups' ? 'members' : 'memberships', quantifier: 'any', where: emptyRule() }
          : { field: this.entity === 'groups' ? 'group.display_name' : 'member.card', op: 'regex', value: '' };
        group.rules.push(child);
        this.paintTree();
      } else if (remove) {
        this.markTemporary();
        const path = remove.dataset.removeRule.split('.');
        if (path.at(-1) === 'where') this.get(path.slice(0, -1).join('.')).where = emptyRule();
        else { const index = Number(path.pop()); this.get(path.join('.')).splice(index, 1); }
        this.paintTree();
      }
    });
  }

  paintTree() {
    // 预设可以是一条条件；在编辑器中仍能继续组合其他条件。
    if (!this.draft.rules) this.draft = { op: 'and', rules: [this.draft] };
    const prepare = rule => {
      if (rule.relation) {
        if (!rule.where?.rules) rule.where = { op: 'and', rules: rule.where ? [rule.where] : [] };
        prepare(rule.where);
      }
      rule.rules?.forEach(prepare);
    };
    prepare(this.draft);
    this.tree.innerHTML = renderRule(this.draft);
  }

  error(message = '') { this.element.querySelector('.filter-error').textContent = message; }

  apply() {
    this.rule = clone(this.draft);
    this.error();
    const node = this.element.querySelector('.filter-summary');
    node.textContent = summary(this.rule); node.title = node.textContent;
    this.onApply?.(clone(this.rule));
  }

  async save(update) {
    try {
      if (update && (!this.selectedPreset || this.selectedPreset.startsWith('builtin-'))) throw new Error('请选择自定义预设，或使用“另存为新预设”。');
      const name = this.element.querySelector('.filter-save-form input').value.trim();
      const data = await api.post('/api/filter-presets', { name, rule: this.draft, id: update ? this.selectedPreset : undefined });
      this.selectedPreset = data.preset.id;
      this.temporary = false;
      updatePresets(data);
      toast('筛选预设已保存，可在其他视图使用', 'ok');
      this.error();
    } catch (error) { this.error(error.message); }
  }
}

export const fieldSelectOptions = fieldOptions;
