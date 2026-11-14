// 群设置模板：编辑 → 逐群差异 → 套用

import * as api from '../api.js';
import { state } from '../state.js';
import { navigate } from '../router.js';
import {
  toast, esc, confirmAction, fmtDuration, statusTag, emptyState, openDrawer,
} from '../ui.js';

const DEFAULT_TEMPLATE = {
  name: '新模板',
  group_name: '',
  notice: '',
  whole_ban: 'keep',
  portrait: '',
  add_option: { mode: 'keep', question: '', answer: '' },
  search_option: 'keep',
};

let template = { ...DEFAULT_TEMPLATE, add_option: { ...DEFAULT_TEMPLATE.add_option } };
let selectedGroups = new Set();
let diff = null;
let running = null;

function templateForm() {
  return `
    <div class="card">
      <div class="card-head"><h3>模板内容</h3><span class="sub">留空 = 不修改</span></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:16px">
        <div class="field">
          <label for="s-name">模板名称</label>
          <input class="input" id="s-name" value="${esc(template.name)}" placeholder="例如 活动期群设置" />
        </div>

        <div class="section-title">基础信息</div>
        <div class="field">
          <label for="s-groupname">群名称</label>
          <input class="input" id="s-groupname" value="${esc(template.group_name)}" placeholder="留空不改；可用 {group_name} 保留原名" />
          <span class="help">支持 {group_name} {group_id} 两个变量。</span>
        </div>
        <div class="field">
          <label for="s-portrait">群头像</label>
          <input class="input mono" id="s-portrait" value="${esc(template.portrait)}" placeholder="本地绝对路径 或 https 图片直链" />
          <span class="help">协议端不支持时该行会自动置灰并跳过。</span>
        </div>
        <div class="field">
          <label for="s-ban">全员禁言</label>
          <select class="select" id="s-ban">
            <option value="keep" ${template.whole_ban === 'keep' ? 'selected' : ''}>不修改</option>
            <option value="on" ${template.whole_ban === 'on' ? 'selected' : ''}>开启全员禁言</option>
            <option value="off" ${template.whole_ban === 'off' ? 'selected' : ''}>关闭全员禁言</option>
          </select>
        </div>

        <div class="section-title">公告</div>
        <div class="field">
          <label for="s-notice">群公告</label>
          <textarea class="textarea" id="s-notice" rows="5" placeholder="留空则不改公告">${esc(template.notice)}</textarea>
        </div>

        <div class="section-title">入群与搜索</div>
        <div class="field">
          <label for="s-addmode">加群方式</label>
          <select class="select" id="s-addmode">
            <option value="keep" ${template.add_option.mode === 'keep' ? 'selected' : ''}>不修改</option>
            <option value="open" ${template.add_option.mode === 'open' ? 'selected' : ''}>允许直接加入</option>
            <option value="question" ${template.add_option.mode === 'question' ? 'selected' : ''}>需要回答问题</option>
          </select>
        </div>
        <div id="qa-fields" style="display:${template.add_option.mode === 'question' ? 'flex' : 'none'};flex-direction:column;gap:10px">
          <div class="field">
            <label for="s-question">验证问题</label>
            <input class="input" id="s-question" value="${esc(template.add_option.question)}" />
          </div>
          <div class="field">
            <label for="s-answer">答案</label>
            <input class="input" id="s-answer" value="${esc(template.add_option.answer)}" />
          </div>
        </div>
        <div class="field">
          <label for="s-search">群搜索</label>
          <select class="select" id="s-search">
            <option value="keep" ${template.search_option === 'keep' ? 'selected' : ''}>不修改</option>
            <option value="on" ${template.search_option === 'on' ? 'selected' : ''}>允许通过群号搜索</option>
            <option value="off" ${template.search_option === 'off' ? 'selected' : ''}>禁止搜索</option>
          </select>
          <span class="help">实验性接口，不同协议端参数可能不同，失败不影响其它设置。</span>
        </div>

        <div class="row">
          <button class="btn" id="btn-save-tpl" type="button">保存为模板</button>
          <button class="btn" id="btn-load-tpl" type="button">载入已存模板</button>
        </div>
      </div>
    </div>`;
}

function targetPicker() {
  const groups = state.groups || [];
  if (!groups.length) {
    return `<div class="card"><div class="card-body">${emptyState('没有可用群', '先到「群组」页拉取群列表。')}</div></div>`;
  }
  return `
    <div class="card">
      <div class="card-head">
        <h3>目标群</h3>
        <div class="row">
          <button class="btn btn-sm" id="btn-select-all" type="button">全选</button>
          <button class="btn btn-sm" id="btn-select-none" type="button">清空</button>
        </div>
      </div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:8px;max-height:320px;overflow:auto">
        ${groups
          .map(
            (group) => `
          <label class="row" style="gap:9px;padding:7px 9px;border-radius:9px;cursor:pointer">
            <span class="checkbox">
              <input type="checkbox" data-target="${esc(group.group_id)}" ${selectedGroups.has(group.group_id) ? 'checked' : ''} />
              <span></span>
            </span>
            <span style="min-width:0;flex:1 1 auto">
              <span class="strong small" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(group.group_name)}</span>
              <span class="mono tiny faint">${esc(group.group_id)} · ${group.member_count} 人</span>
            </span>
            ${
              ['owner', 'admin'].includes(group.my_role)
                ? ''
                : '<span class="tag tag-danger">无权限</span>'
            }
          </label>`
          )
          .join('')}
      </div>
      <div class="card-body tight" style="border-top:1px solid var(--line)">
        <span class="tiny faint">已选 <span id="target-count">${selectedGroups.size}</span> 个群</span>
      </div>
    </div>`;
}

function diffHtml() {
  if (!diff) {
    return emptyState('还没有生成差异', '左侧填好模板、右侧勾选目标群，点「生成差异」预览每个群会发生什么。');
  }
  const blocks = diff.groups
    .map((group, index) => {
      const rows = group.fields
        .map((field) => {
          const cls = !field.supported ? 'unsupported' : field.changed ? 'changed' : '';
          const note = !field.supported
            ? '<span class="tag tag-danger">不支持</span>'
            : field.note
              ? `<span class="tag tag-ghost">${esc(field.note)}</span>`
              : '';
          return `
            <div class="diff-row ${cls}">
              <span class="small muted">${esc(field.label)}</span>
              <span class="old">${esc(field.from || '—')}</span>
              <span class="arrow">→</span>
              <span class="new">${esc(field.to || '—')} ${note}</span>
            </div>`;
        })
        .join('');
      return `
        <div class="accordion ${index === 0 ? 'open' : ''}">
          <div class="accordion-head">
            <svg class="caret" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>
            <span class="strong small">${esc(group.group_name)}</span>
            <span class="mono tiny faint">${esc(group.group_id)}</span>
            <span class="spacer"></span>
            ${group.actionable ? `<span class="tag tag-admin">${group.actionable} 项变更</span>` : '<span class="tag">无变化</span>'}
          </div>
          <div class="accordion-body">${rows || '<p class="small faint">没有需要变更的项目</p>'}</div>
        </div>`;
    })
    .join('');

  return `
    <div class="row" style="margin-bottom:10px">
      <span class="small muted">共 <strong>${diff.groups.length}</strong> 个群，<strong class="text-primary">${diff.total_changes}</strong> 项变更</span>
      <span class="spacer"></span>
      <span class="tag tag-teal">${esc(diff.template.name)}</span>
    </div>
    ${(diff.warnings || []).map((text) => `<div class="hint-box warn" style="margin-bottom:8px"><span class="hint-icon">!</span><div>${esc(text)}</div></div>`).join('')}
    ${blocks}`;
}

export async function render(root) {
  if (!state.groups?.length) {
    try {
      const data = await api.get('/api/groups');
      state.groups = data.groups;
    } catch (error) {
      /* 下方会提示 */
    }
  }

  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>群设置模板</h1>
          <p>把群名、公告、全员禁言、头像等打包成模板，一次套用到多个群。</p>
        </div>
        <div class="page-actions">
          <button class="btn" id="btn-goto-groups" type="button">管理群列表</button>
        </div>
      </div>

      <div class="split">
        <div>${templateForm()}</div>
        <div style="display:flex;flex-direction:column;gap:14px">
          ${targetPicker()}
          <div class="card">
            <div class="card-head">
              <h3>差异预览</h3>
              <button class="btn btn-sm" id="btn-diff" type="button">生成差异</button>
            </div>
            <div class="card-body" id="diff-body">${diffHtml()}</div>
          </div>
          <div class="card">
            <div class="card-body" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <button class="btn btn-primary" id="btn-apply" type="button" ${diff && diff.total_changes ? '' : 'disabled'}>套用模板</button>
              <span class="tiny faint">执行前会保存一份快照记录。</span>
            </div>
          </div>
          <div class="card" id="progress-card" style="display:none">
            <div class="card-head"><h3>执行进度</h3><div class="row" id="progress-actions"></div></div>
            <div class="card-body" id="progress-body"></div>
          </div>
        </div>
      </div>
    </div>`;

  const diffBody = root.querySelector('#diff-body');

  const readForm = () => {
    template = {
      name: root.querySelector('#s-name').value.trim() || '未命名模板',
      group_name: root.querySelector('#s-groupname').value.trim(),
      notice: root.querySelector('#s-notice').value,
      whole_ban: root.querySelector('#s-ban').value,
      portrait: root.querySelector('#s-portrait').value.trim(),
      add_option: {
        mode: root.querySelector('#s-addmode').value,
        question: root.querySelector('#s-question').value.trim(),
        answer: root.querySelector('#s-answer').value.trim(),
      },
      search_option: root.querySelector('#s-search').value,
    };
    return template;
  };

  root.querySelector('#s-addmode').addEventListener('change', (event) => {
    root.querySelector('#qa-fields').style.display = event.target.value === 'question' ? 'flex' : 'none';
  });

  root.querySelectorAll('[data-target]').forEach((node) => {
    node.addEventListener('change', () => {
      if (node.checked) selectedGroups.add(node.dataset.target);
      else selectedGroups.delete(node.dataset.target);
      root.querySelector('#target-count').textContent = selectedGroups.size;
      diff = null;
      diffBody.innerHTML = diffHtml();
      root.querySelector('#btn-apply').disabled = true;
    });
  });

  root.querySelector('#btn-select-all')?.addEventListener('click', () => {
    (state.groups || []).forEach((group) => selectedGroups.add(group.group_id));
    root.querySelectorAll('[data-target]').forEach((node) => { node.checked = true; });
    root.querySelector('#target-count').textContent = selectedGroups.size;
  });

  root.querySelector('#btn-select-none')?.addEventListener('click', () => {
    selectedGroups.clear();
    root.querySelectorAll('[data-target]').forEach((node) => { node.checked = false; });
    root.querySelector('#target-count').textContent = 0;
  });

  root.querySelector('#btn-goto-groups').addEventListener('click', () => navigate('groups'));

  root.querySelector('#btn-diff').addEventListener('click', async () => {
    const button = root.querySelector('#btn-diff');
    if (!selectedGroups.size) {
      toast('请先勾选目标群', 'warn');
      return;
    }
    button.disabled = true;
    button.textContent = '计算中…';
    try {
      diff = await api.post('/api/settings/preview', {
        group_ids: [...selectedGroups],
        template: readForm(),
      });
      diffBody.innerHTML = diffHtml();
      root.querySelector('#btn-apply').disabled = !diff.total_changes;
      toast(diff.total_changes ? `共 ${diff.total_changes} 项变更` : '没有需要变更的设置', diff.total_changes ? 'ok' : 'warn');
    } catch (error) {
      toast(error.message, 'err', error.hint);
    } finally {
      button.disabled = false;
      button.textContent = '生成差异';
    }
  });

  root.querySelector('#btn-save-tpl').addEventListener('click', async () => {
    try {
      const data = await api.post('/api/templates', { template: readForm() });
      state.config = data.config;
      toast(`模板「${data.template.name}」已保存`, 'ok');
    } catch (error) {
      toast(error.message, 'err', error.hint);
    }
  });

  root.querySelector('#btn-load-tpl').addEventListener('click', () => {
    const templates = state.config?.templates || [];
    if (!templates.length) {
      toast('还没有保存过模板', 'warn');
      return;
    }
    openDrawer({
      title: '已保存的模板',
      body: templates
        .map(
          (item) => `
        <div class="row" style="padding:10px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px">
          <span class="strong small">${esc(item.name)}</span>
          <span class="spacer"></span>
          <button class="btn btn-sm" data-use="${esc(item.id)}" type="button">载入</button>
          <button class="btn btn-sm btn-danger" data-del="${esc(item.id)}" type="button">删除</button>
        </div>`
        )
        .join(''),
      onMount: (panel) => {
        panel.querySelectorAll('[data-use]').forEach((node) => {
          node.addEventListener('click', () => {
            const found = templates.find((item) => item.id === node.dataset.use);
            if (found) {
              template = { ...DEFAULT_TEMPLATE, ...found, add_option: { ...DEFAULT_TEMPLATE.add_option, ...(found.add_option || {}) } };
              render(document.getElementById('view'));
              toast(`已载入「${found.name}」`, 'ok');
            }
          });
        });
        panel.querySelectorAll('[data-del]').forEach((node) => {
          node.addEventListener('click', async () => {
            try {
              state.config = await api.del(`/api/templates/${node.dataset.del}`);
              node.closest('.row').remove();
              toast('已删除', 'ok');
            } catch (error) {
              toast(error.message, 'err');
            }
          });
        });
      },
    });
  });

  const renderProgress = (job) => {
    const card = root.querySelector('#progress-card');
    card.style.display = '';
    const total = job.total || 1;
    root.querySelector('#progress-body').innerHTML = `
      <div class="progress">
        <div class="bar-ok" style="width:${(job.ok / total) * 100}%"></div>
        <div class="bar-fail" style="width:${(job.fail / total) * 100}%"></div>
        <div class="bar-idle"></div>
      </div>
      <div class="progress-meta" style="margin-top:8px">
        <span>成功 ${job.ok} · 失败 ${job.fail} · 进度 ${job.ok + job.fail}/${job.total}</span>
        <span>${job.status === 'running' ? `剩余约 ${fmtDuration(job.eta_seconds)}` : statusTag(job.status)}</span>
      </div>`;
    const actions = root.querySelector('#progress-actions');
    actions.innerHTML = job.status === 'running'
      ? '<button class="btn btn-sm btn-danger" id="btn-cancel-job" type="button">中止</button>'
      : statusTag(job.status);
    actions.querySelector('#btn-cancel-job')?.addEventListener('click', async () => {
      try {
        await api.post(`/api/jobs/${job.id}/cancel`, {});
        toast('已请求中止', 'warn');
      } catch (error) {
        toast(error.message, 'err');
      }
    });
  };

  root.querySelector('#btn-apply').addEventListener('click', async () => {
    if (!diff || !diff.total_changes) return;
    if (running) {
      toast('已有任务在执行', 'warn');
      return;
    }
    const ok = await confirmAction({
      title: '确认套用模板',
      message: `即将对 ${diff.groups.length} 个群执行 ${diff.total_changes} 项变更。`,
      hint: '群名称、公告等修改后不会自动还原，请确认目标群无误。',
      confirmText: '确认套用',
      danger: true,
    });
    if (!ok) return;

    try {
      const data = await api.post('/api/settings/execute', {
        group_ids: [...selectedGroups],
        template: readForm(),
        interval: state.config?.batch?.interval ?? 2,
        confirmed: true,
      });
      running = data.job.id;
      toast(`已提交 ${data.planned} 项变更`, 'ok');
      renderProgress(data.job);
      const job = await api.pollJob(data.job.id, renderProgress);
      running = null;
      toast(job.fail ? `完成，失败 ${job.fail} 项` : '全部完成', job.fail ? 'warn' : 'ok');
      diff = null;
      diffBody.innerHTML = diffHtml();
      root.querySelector('#btn-apply').disabled = true;
    } catch (error) {
      running = null;
      toast(error.message, 'err', error.hint);
    }
  });

  if (diff) diffBody.innerHTML = diffHtml();
}

export async function refresh() {
  try {
    const data = await api.get('/api/groups', { refresh: 1 });
    state.groups = data.groups;
  } catch (error) {
    toast(error.message, 'err', error.hint);
  }
  await render(document.getElementById('view'));
}
