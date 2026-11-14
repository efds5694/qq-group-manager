// 批量改名片：模板 → 预演 → 试改 → 全量

import * as api from '../api.js';
import { state } from '../state.js';
import { navigate } from '../router.js';
import {
  toast, esc, confirmAction, openDrawer, fmtNumber, fmtDuration, roleTag, statusTag, emptyState,
} from '../ui.js';

const VARIABLES = [
  ['{nickname}', '成员昵称'],
  ['{card}', '原群名片'],
  ['{qq}', 'QQ 号'],
  ['{group_name}', '群名称'],
  ['{index}', '序号'],
  ['{level}', '活跃等级'],
  ['{join_year}', '入群年份'],
  ['{title}', '群头衔'],
];

let local = {
  template: '{nickname}',
  scope: 'all',
  role: 'member',
  year: 'all',
  interval: 2,
  mapping: {},
  mappingName: '',
};

let plan = null;
let running = null;

function scopeOptions() {
  return [
    ['all', '全部成员'],
    ['selected', `已勾选（${state.selection.size}）`],
    ['empty_card', '仅空名片'],
    ['role', '按身份'],
    ['year', '按入群年份'],
    ['mapping', '按导入名单'],
  ];
}

function statCard(label, value, cls = '') {
  return `<div class="stat"><span class="label">${esc(label)}</span><span class="value ${cls}">${value}</span></div>`;
}

function renderPlan(container) {
  if (!plan) {
    container.innerHTML = emptyState(
      '还没有预演结果',
      '填好模板、选好范围，点左侧「预演差异」。预演不会修改任何数据。'
    );
    return;
  }

  const stats = plan.stats;
  const warnings = (plan.warnings || [])
    .map(
      (text) => `<div class="hint-box warn"><span class="hint-icon">!</span><div>${esc(text)}</div></div>`
    )
    .join('');

  const rows = plan.items
    .map(
      (item) => `
      <tr>
        <td style="width:34px"><span class="mono faint tiny">${esc(item.qq)}</span></td>
        <td>
          <div class="name-cell">
            <span class="primary-name">${esc(item.nickname || '（无昵称）')}</span>
            <span class="secondary-name">${esc(item.role_label)}</span>
          </div>
        </td>
        <td><span class="old faint">${esc(item.old_card || '空名片')}</span></td>
        <td><span class="text-primary strong">${esc(item.new_card)}</span></td>
      </tr>`
    )
    .join('');

  const skipped = plan.skipped.length
    ? `
      <details style="margin-top:10px">
        <summary class="small muted" style="cursor:pointer">查看被跳过的 ${plan.skipped.length} 人</summary>
        <div class="table-wrap" style="margin-top:8px;max-height:240px">
          <table class="table">
            <thead><tr><th>成员</th><th>QQ 号</th><th>原因</th></tr></thead>
            <tbody>
              ${plan.skipped
                .slice(0, 300)
                .map(
                  (item) => `<tr>
                    <td>${esc(item.display_name)}</td>
                    <td class="mono num">${esc(item.qq)}</td>
                    <td class="small muted">${esc(item.reason)}</td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </details>`
    : '';

  container.innerHTML = `
    <div class="grid grid-4" style="margin-bottom:12px">
      ${statCard('候选成员', fmtNumber(stats.candidates))}
      ${statCard('将修改', fmtNumber(stats.change), 'primary')}
      ${statCard('跳过', fmtNumber(stats.skip))}
      ${statCard('预计耗时', fmtDuration(plan.eta_seconds))}
    </div>
    ${warnings}
    ${
      plan.items.length
        ? `<div class="table-wrap" style="max-height:340px;margin-top:12px">
            <table class="table plan-table">
              <thead><tr><th>QQ</th><th>成员</th><th>旧名片</th><th>新名片</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          ${plan.items.length > 300 ? `<p class="tiny faint" style="margin-top:6px">仅展示前 300 条，执行时仍会处理全部 ${fmtNumber(plan.items.length)} 人。</p>` : ''}
          ${skipped}`
        : `<div class="hint-box" style="margin-top:12px"><span class="hint-icon">i</span><div>没有需要修改的成员：可能是名片本来就一致，或全部被权限规则跳过。</div></div>`
    }`;
}

function progressHtml(job) {
  const done = job.ok + job.fail;
  const total = job.total || 1;
  const okWidth = (job.ok / total) * 100;
  const failWidth = (job.fail / total) * 100;
  return `
    <div class="progress">
      <div class="bar-ok" style="width:${okWidth}%"></div>
      <div class="bar-fail" style="width:${failWidth}%"></div>
      <div class="bar-idle"></div>
    </div>
    <div class="progress-meta" style="margin-top:8px">
      <span>成功 <strong class="text-ok">${job.ok}</strong> · 失败 <strong class="text-danger">${job.fail}</strong> · 进度 ${done}/${job.total}</span>
      <span>${job.status === 'running' ? `预计剩余 ${fmtDuration(job.eta_seconds)}` : statusTag(job.status)}</span>
    </div>`;
}

export async function render(root) {
  if (!state.group) {
    root.innerHTML = `<div class="page"><div class="card"><div class="card-body">
      ${emptyState('还没有选择群', '批量改名需要一个目标群，先到「群组」页选择。')}
      <div class="row" style="justify-content:center"><button class="btn btn-primary" id="goto-groups" type="button">去选择群</button></div>
    </div></div></div>`;
    root.querySelector('#goto-groups')?.addEventListener('click', () => navigate('groups'));
    return;
  }

  const group = state.group;
  // 换群就丢掉上一次的预演结果，避免把 A 群的计划带到 B 群
  if (local.groupId !== group.group_id) {
    local.groupId = group.group_id;
    plan = null;
  }
  // 从成员页带着勾选进来时，默认只改勾选的人，避免误伤全群
  if (state.selection.size > 0 && local.scope === 'all' && !local.scopeTouched) {
    local.scope = 'selected';
  }

  const batch = state.config?.batch || {};
  const min = batch.min_interval ?? 0.8;
  const max = batch.max_interval ?? 10;
  if (!local.interval) local.interval = batch.interval ?? 2;
  if (!['owner', 'admin'].includes(group.my_role)) {
    root.innerHTML = `<div class="page"><div class="card"><div class="card-body">
      <div class="hint-box danger"><span class="hint-icon">!</span>
      <div>你在「${esc(group.group_name)}」里是普通成员，无法修改名片。请让机器人账号成为管理员或群主。</div></div>
      <div class="row" style="margin-top:12px"><button class="btn" id="back" type="button">返回成员列表</button></div>
    </div></div></div>`;
    root.querySelector('#back')?.addEventListener('click', () => navigate('members'));
    return;
  }

  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>批量改名片</h1>
          <p>${esc(group.group_name)} · 群号 <span class="mono">${esc(group.group_id)}</span> · 先预演，确认无误再执行。</p>
        </div>
        <div class="page-actions">
          <button class="btn" id="btn-to-members" type="button">回到成员列表</button>
        </div>
      </div>

      <div class="split">
        <div style="display:flex;flex-direction:column;gap:14px">
          <div class="card">
            <div class="card-head"><h3>名片模板</h3><span class="sub">支持变量</span></div>
            <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
              <input class="input mono" id="tpl-input" value="${esc(local.template)}" placeholder="{nickname}" />
              <div class="var-list">
                ${VARIABLES.map(
                  ([token, label]) => `<button class="chip" data-var="${esc(token)}" title="${esc(label)}" type="button">${esc(token)}</button>`
                ).join('')}
              </div>
              <div class="hint-box">
                <span class="hint-icon">i</span>
                <div>例：<span class="mono">{nickname}-2026</span> 保留原名加后缀；<span class="mono">{index:02d}</span> 这类格式化暂不支持。
                名片上限 40 字符，超出会自动截断。</div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>作用范围</h3><span class="sub" id="scope-sub"></span></div>
            <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
              <select class="select" id="scope-select">
                ${scopeOptions().map(([value, label]) => `<option value="${value}" ${local.scope === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}
              </select>
              <div class="field" id="role-field" style="display:none">
                <label>身份</label>
                <select class="select" id="role-select">
                  <option value="member">普通成员</option>
                  <option value="admin">管理员</option>
                </select>
              </div>
              <div class="field" id="year-field" style="display:none">
                <label>入群年份</label>
                <input class="input" id="year-input" placeholder="例如 2025" value="${esc(local.year)}" />
              </div>
              <div class="field" id="mapping-field" style="display:none">
                <label>导入名单（CSV：QQ号,新名片）</label>
                <input type="file" id="mapping-file" accept=".csv,.txt" class="input" style="height:auto;padding:7px" />
                <span class="help" id="mapping-help">${local.mappingName ? esc(local.mappingName) : '仅在「按导入名单」时生效'}</span>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>执行节奏</h3><span class="sub" id="interval-label">${local.interval.toFixed(1)} 秒/条</span></div>
            <div class="card-body">
              <input type="range" id="interval-range" min="${min}" max="${max}" step="0.2" value="${local.interval}" style="width:100%" />
              <div class="row" style="justify-content:space-between;margin-top:6px">
                <span class="tiny faint">${min} 秒（更快，易触发风控）</span>
                <span class="tiny faint">${max} 秒（更稳）</span>
              </div>
            </div>
          </div>

          <div class="row">
            <button class="btn btn-primary btn-lg btn-block" id="btn-preview" type="button">预演差异</button>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:14px">
          <div class="card" id="progress-card" style="display:none">
            <div class="card-head">
              <h3>执行进度</h3>
              <div class="row" id="progress-actions"></div>
            </div>
            <div class="card-body" id="progress-body"></div>
          </div>

          <div class="card">
            <div class="card-head">
              <h3>预演结果</h3>
              <span class="sub" id="plan-sub">${plan ? esc(plan.scope_label || '') : '未预演'}</span>
            </div>
            <div class="card-body" id="plan-body"></div>
          </div>

          <div class="card" id="execute-card" style="display:${plan ? '' : 'none'}">
            <div class="card-body" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <button class="btn" id="btn-trial" type="button">试改前 10 人</button>
              <button class="btn btn-primary" id="btn-full" type="button">全量执行</button>
              <span class="spacer"></span>
              <span class="tiny faint" id="exec-hint">建议先试改 10 人，确认效果后再全量。</span>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  const tplInput = root.querySelector('#tpl-input');
  const scopeSelect = root.querySelector('#scope-select');
  const roleField = root.querySelector('#role-field');
  const yearField = root.querySelector('#year-field');
  const mappingField = root.querySelector('#mapping-field');
  const roleSelect = root.querySelector('#role-select');
  const yearInput = root.querySelector('#year-input');
  const intervalRange = root.querySelector('#interval-range');
  const intervalLabel = root.querySelector('#interval-label');
  const planBody = root.querySelector('#plan-body');
  const executeCard = root.querySelector('#execute-card');
  const progressCard = root.querySelector('#progress-card');

  const syncScopeFields = () => {
    roleField.style.display = local.scope === 'role' ? '' : 'none';
    yearField.style.display = local.scope === 'year' ? '' : 'none';
    mappingField.style.display = local.scope === 'mapping' ? '' : 'none';
    root.querySelector('#scope-sub').textContent =
      local.scope === 'selected' ? `已勾选 ${state.selection.size} 人` : '';
  };
  syncScopeFields();

  root.querySelectorAll('[data-var]').forEach((node) => {
    node.addEventListener('click', () => {
      const token = node.dataset.var;
      const start = tplInput.selectionStart ?? tplInput.value.length;
      const end = tplInput.selectionEnd ?? start;
      tplInput.value = tplInput.value.slice(0, start) + token + tplInput.value.slice(end);
      tplInput.focus();
      tplInput.setSelectionRange(start + token.length, start + token.length);
      local.template = tplInput.value;
    });
  });

  tplInput.addEventListener('input', () => {
    local.template = tplInput.value;
  });

  scopeSelect.addEventListener('change', () => {
    local.scope = scopeSelect.value;
    local.scopeTouched = true;
    syncScopeFields();
  });

  roleSelect.addEventListener('change', () => {
    local.role = roleSelect.value;
  });
  yearInput.addEventListener('input', () => {
    local.year = yearInput.value.trim();
  });

  intervalRange.addEventListener('input', () => {
    local.interval = Number(intervalRange.value);
    intervalLabel.textContent = `${local.interval.toFixed(1)} 秒/条`;
  });

  root.querySelector('#mapping-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const mapping = {};
    text.replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .forEach((line) => {
        const [qq, ...rest] = line.split(',');
        const key = (qq || '').trim().replace(/^"|"$/g, '');
        const value = rest.join(',').trim().replace(/^"|"$/g, '');
        if (/^\d{5,}$/.test(key) && value) mapping[key] = value;
      });
    local.mapping = mapping;
    local.mappingName = `${file.name} · 解析到 ${Object.keys(mapping).length} 条`;
    root.querySelector('#mapping-help').textContent = local.mappingName;
  });

  const options = () => ({
    template: local.template,
    scope: local.scope,
    selected: [...state.selection],
    role: local.role,
    year: local.year,
    mapping: local.mapping,
    interval: local.interval,
  });

  const runPreview = async () => {
    if (local.scope !== 'mapping' && !local.template.trim()) {
      toast('请先填写名片模板', 'warn');
      tplInput.focus();
      return;
    }
    if (local.scope === 'selected' && state.selection.size === 0) {
      toast('还没有勾选成员', 'warn', '到成员页勾选，或改成其它范围。');
      return;
    }
    const button = root.querySelector('#btn-preview');
    button.disabled = true;
    button.textContent = '预演中…';
    try {
      plan = await api.post('/api/cards/preview', { group_id: group.group_id, options: options() });
      state.plan = plan;
      renderPlan(planBody);
      root.querySelector('#plan-sub').textContent = `${plan.scope_label} · ${plan.stats.change} 人将变更`;
      executeCard.style.display = '';
      root.querySelector('#exec-hint').textContent = `预计耗时 ${fmtDuration(plan.eta_seconds)}，执行前会自动保存快照。`;
      toast(`预演完成：${plan.stats.change} 人待修改，${plan.stats.skip} 人跳过`, plan.stats.change ? 'ok' : 'warn');
    } catch (error) {
      toast(error.message, 'err', error.hint);
    } finally {
      button.disabled = false;
      button.textContent = '预演差异';
    }
  };

  const renderProgress = (job) => {
    progressCard.style.display = '';
    root.querySelector('#progress-body').innerHTML = progressHtml(job);
    const actions = root.querySelector('#progress-actions');
    if (job.status === 'running' || job.status === 'pending') {
      actions.innerHTML = '<button class="btn btn-sm btn-danger" id="btn-cancel" type="button">中止</button>';
      actions.querySelector('#btn-cancel').addEventListener('click', async () => {
        try {
          await api.post(`/api/jobs/${job.id}/cancel`, {});
          toast('已发送中止请求，当前这一条会执行完', 'warn');
        } catch (error) {
          toast(error.message, 'err');
        }
      });
    } else {
      actions.innerHTML = statusTag(job.status);
    }
  };

  const execute = async (mode) => {
    if (!plan || !plan.items.length) {
      toast('先预演确认有需要修改的人', 'warn');
      return;
    }
    if (running) {
      toast('已有任务在执行，等它结束', 'warn');
      return;
    }

    const count = mode === 'trial' ? Math.min(10, plan.items.length) : plan.items.length;
    if (mode === 'full' && count > 100) {
      const ok = await confirmAction({
        title: '确认全量执行',
        message: `即将修改 ${count} 人的群名片，预计耗时 ${fmtDuration(count * local.interval)}。`,
        hint: '执行前会自动保存快照，可在任务中心一键回滚。',
        confirmText: `确认修改 ${count} 人`,
        danger: true,
      });
      if (!ok) return;
    }

    try {
      const data = await api.post('/api/cards/execute', {
        group_id: group.group_id,
        options: options(),
        mode,
        confirmed: true,
      });
      running = data.job.id;
      toast(`任务已开始：${data.planned} 人`, 'ok', `快照 ${data.snapshot.id}`);
      renderProgress(data.job);

      const job = await api.pollJob(data.job.id, renderProgress);
      running = null;
      const summary =
        job.status === 'canceled'
          ? `已中止：成功 ${job.ok}，失败 ${job.fail}`
          : `完成：成功 ${job.ok}，失败 ${job.fail}`;
      toast(summary, job.fail ? 'warn' : 'ok', '可在任务中心查看逐条结果或回滚。');
    } catch (error) {
      running = null;
      toast(error.message, 'err', error.hint);
    }
  };

  root.querySelector('#btn-preview').addEventListener('click', runPreview);
  root.querySelector('#btn-trial').addEventListener('click', () => execute('trial'));
  root.querySelector('#btn-full').addEventListener('click', () => execute('full'));
  root.querySelector('#btn-to-members').addEventListener('click', () => navigate('members'));

  renderPlan(planBody);
}

export async function refresh() {
  await render(document.getElementById('view'));
}
