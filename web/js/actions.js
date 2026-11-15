import * as api from './api.js';
import { state } from './state.js';
import { esc, openDrawer, closeDrawer, toast, fmtDuration } from './ui.js';
import { clone, fieldSelectOptions, regexHelpLink } from './filters.js';
import { requestData, jobBanner, names, errorBox } from './workspace.js';

export function openRename(querySpec, progressElement, onFinish) {
  const sources = querySpec.scope?.source_group_ids || [];
  const trialSize = Number(state.config?.batch?.trial_size) || 10;
  let plan = null;
  let mapping = {};
  let revision = 0;
  openDrawer({ title: '批量改群昵称', wide: true,
    body: `<div class="rename-layout"><form class="rename-form" onsubmit="return false">
      <div class="field"><label>生成方式</label><select class="input" id="rename-method"><option value="sync" ${sources.length ? '' : 'disabled'}>同步基准群昵称</option><option value="template" ${sources.length ? '' : 'selected'}>按变量模板</option><option value="mapping">按 CSV 名单</option></select></div>
      <div class="rename-source-note"><span class="eyebrow">基准群优先级</span><p>${sources.length ? names(sources).map((name, index) => `${index+1}. ${esc(name)}`).join('<br>') : '尚未设置基准群，可关闭后在工作台配置。'}</p></div>
      <div class="field"><label>源文本字段</label><select class="input" id="rename-source">${fieldSelectOptions('member.card')}</select></div>
      <div class="field"><label>正则处理 ${regexHelpLink()}</label><select class="input" id="rename-regex-mode"><option value="off">直接使用源文本</option><option value="extract">提取捕获组</option><option value="replace">正则替换</option></select></div>
      <div id="rename-regex-fields" hidden><div class="field"><label>正则表达式</label><input class="input mono" id="rename-pattern" placeholder="例如 ^\\d+级-(.+?)-.*$"/></div>
        <div class="field"><label>捕获组（提取时）</label><input class="input" id="rename-capture" value="1" placeholder="组序号或命名组名"/></div>
        <div class="field"><label>替换文本（替换时）</label><input class="input mono" id="rename-replacement" placeholder="例如 \\g<name>"/></div>
        <div class="field"><label>正则标记</label><input class="input" id="rename-flags" placeholder="i 忽略大小写，m 多行，s 跨行"/></div></div>
      <div class="field"><label>最终群昵称模板</label><input class="input mono" id="rename-template" value="${sources.length ? '{result}' : '{nickname}'}"/><span class="help">{result} 正则结果 · {nickname} 昵称 · {card} 原群昵称 · {qq} QQ号 · {group_name} 群名 · {index} 序号 · {level} 等级 · {join_year} 加群年份 · {title} 头衔</span></div>
      <div class="field" id="rename-file-field" hidden><label>CSV 名单</label><input class="input" type="file" id="rename-file" accept=".csv,text/csv"/><span class="help" id="rename-file-count">两列：QQ号、新群昵称。可带表头。</span></div>
      <label class="check-inline small"><input type="checkbox" id="rename-only-empty"/>仅修改目标群空群昵称</label>
      <div class="field"><label>每条操作间隔（秒）</label><input class="input" id="rename-interval" type="number" min="${Number(state.config?.batch?.min_interval) || 0.8}" max="10" step="0.2" value="${Number(state.config?.batch?.interval) || 2}"/></div>
      <p class="tiny faint">同步方式只修改目标群。正则未匹配、空结果、无权限和相同昵称会在预演中跳过。</p>
      </form><section class="rename-preview"><div id="rename-read-progress" hidden></div><div id="rename-preview-result"><div class="empty"><strong>先检查生成结果，再执行</strong><p>预演会重新读取名单，并展示每条群昵称的变化。</p></div></div></section></div>`,
    footer: `<label class="check-inline rename-confirm" hidden><input id="rename-confirm" type="checkbox"/><span>已核对，确认全量修改超过 100 条群昵称</span></label><span class="rename-error" role="alert"></span><button class="btn" data-close="1">关闭</button><button class="btn btn-primary" id="rename-preview">预演差异</button><button class="btn" id="rename-trial" hidden>试改前 ${trialSize} 条</button><button class="btn btn-primary" id="rename-execute" hidden>全量执行</button>`,
    onMount(panel, foot) {
      const previewButton = foot.querySelector('#rename-preview');
      const trial = foot.querySelector('#rename-trial');
      const execute = foot.querySelector('#rename-execute');
      const confirm = foot.querySelector('#rename-confirm');
      const result = panel.querySelector('#rename-preview-result');
      const form = panel.querySelector('form');
      const invalidate = () => {
        revision++; plan = null; trial.hidden = true; execute.hidden = true;
        foot.querySelector('.rename-confirm').hidden = true; confirm.checked = false;
        foot.querySelector('.rename-error').textContent = '';
      };
      form.addEventListener('input', invalidate);
      form.addEventListener('change', invalidate);
      panel.querySelector('#rename-method').addEventListener('change', event => {
        const method = event.target.value;
        panel.querySelector('#rename-file-field').hidden = method !== 'mapping';
        panel.querySelector('#rename-template').value = method === 'template' ? '{nickname}' : '{result}';
      });
      panel.querySelector('#rename-regex-mode').addEventListener('change', event => { panel.querySelector('#rename-regex-fields').hidden = event.target.value === 'off'; });
      panel.querySelector('#rename-file').addEventListener('change', async event => {
        const file = event.target.files[0];
        mapping = {};
        panel.querySelector('#rename-file-count').textContent = '正在读取名单…';
        if (!file) return;
        try {
          const data = await api.post('/api/rename/import', { text: await file.text() });
          if (panel.querySelector('#rename-file').files[0] !== file) return;
          mapping = data.mapping; panel.querySelector('#rename-file-count').textContent = `已载入 ${data.count} 人`;
        } catch (error) { foot.querySelector('.rename-error').textContent = error.message; }
      });
      const options = () => ({ method: panel.querySelector('#rename-method').value, source_field: panel.querySelector('#rename-source').value,
        template: panel.querySelector('#rename-template').value, mapping,
        regex: { mode: panel.querySelector('#rename-regex-mode').value, pattern: panel.querySelector('#rename-pattern').value,
          capture: panel.querySelector('#rename-capture').value, replacement: panel.querySelector('#rename-replacement').value,
          flags: panel.querySelector('#rename-flags').value.trim() } });
      let previewPage = 1;
      let tab = 'items';
      function paint() {
        const list = plan[tab];
        const pages = Math.max(1, Math.ceil(list.length/50));
        result.innerHTML = `<div class="preview-summary"><strong>${plan.stats.people} 人</strong><span>${plan.stats.change} 条待修改</span><span>${plan.stats.skip} 条跳过</span><span>预计 ${fmtDuration(plan.eta_seconds)}</span></div>
          ${plan.warnings.length ? `<details class="warning-details"><summary>注意事项 ${plan.warnings.length}</summary>${plan.warnings.map(warning => `<p>${esc(warning)}</p>`).join('')}</details>` : ''}
          <div class="view-tabs"><button class="${tab === 'items' ? 'active' : ''}" data-preview-tab="items">待修改</button><button class="${tab === 'skipped' ? 'active' : ''}" data-preview-tab="skipped">跳过原因</button></div>
          <div class="table-wrap"><table class="table rename-diff"><thead><tr><th>群 / 成员</th><th>${tab === 'items' ? '旧群昵称 → 新群昵称' : '跳过原因'}</th></tr></thead><tbody>${list.slice((previewPage-1)*50, previewPage*50).map(item => `<tr><td><strong>${esc(item.group_name)}</strong><small>${esc(item.nickname || item.display_name || '')} · ${esc(item.qq)}</small></td><td>${tab === 'items' ? `<span class="old-value">${esc(item.old_card || '（空）')}</span><strong class="new-value">→ ${esc(item.new_card)}</strong>${item.clamped ? '<small class="text-warn">已截断至 40 字符</small>' : ''}` : esc(item.reason)}</td></tr>`).join('') || '<tr><td colspan="2">没有记录</td></tr>'}</tbody></table></div>
          <div class="picker-pager"><button class="btn btn-sm" data-preview-page="-1" ${previewPage <= 1 ? 'disabled' : ''}>上一页</button><span>${previewPage} / ${pages}</span><button class="btn btn-sm" data-preview-page="1" ${previewPage >= pages ? 'disabled' : ''}>下一页</button></div>`;
        result.querySelectorAll('[data-preview-tab]').forEach(button => button.addEventListener('click', () => { tab = button.dataset.previewTab; previewPage = 1; paint(); }));
        result.querySelectorAll('[data-preview-page]').forEach(button => button.addEventListener('click', () => { previewPage += Number(button.dataset.previewPage); paint(); }));
      }
      previewButton.addEventListener('click', async () => {
        const ticket = revision;
        const spec = clone(querySpec);
        if (panel.querySelector('#rename-only-empty').checked) spec.filter = { op: 'and', rules: [spec.filter, { field: 'member.card', op: 'empty' }] };
        previewButton.disabled = true; foot.querySelector('.rename-error').textContent = '';
        try {
          const data = await requestData('/api/rename/preview', { query: spec, options: options(), interval: Number(panel.querySelector('#rename-interval').value) }, job => jobBanner(panel.querySelector('#rename-read-progress'), job));
          if (ticket !== revision || !panel.isConnected) return;
          plan = data; previewPage = 1; tab = 'items'; paint();
          trial.hidden = execute.hidden = !plan.items.length;
          foot.querySelector('.rename-confirm').hidden = plan.items.length <= 100;
          execute.disabled = plan.items.length > 100;
        } catch (error) { if (panel.isConnected) foot.querySelector('.rename-error').textContent = `${error.message} ${error.hint || ''}`; }
        finally { previewButton.disabled = false; }
      });
      confirm.addEventListener('change', () => { execute.disabled = !confirm.checked; });
      const run = async mode => {
        if (!plan?.items.length) return;
        foot.querySelectorAll('button').forEach(button => { button.disabled = true; });
        try {
          const items = plan.items.map(({ group_id, qq, new_card, source_group_id }) => ({ group_id, qq, new_card, source_group_id }));
          const data = await api.post('/api/rename/execute', { items, target_group_ids: [...new Set(items.map(item => item.group_id))],
            interval: plan.interval, mode, confirmed: plan.items.length <= 100 || confirm.checked });
          closeDrawer();
          toast(`已提交 ${data.planned} 条群昵称修改`, 'ok', `保存 ${data.snapshots.length} 份逐群快照`);
          await api.pollJob(data.job.id, job => jobBanner(progressElement, job));
          await onFinish?.();
        } catch (error) {
          if (foot.isConnected) { foot.querySelector('.rename-error').textContent = error.message; foot.querySelectorAll('button').forEach(button => { button.disabled = false; }); execute.disabled = plan.items.length > 100 && !confirm.checked; }
          else toast(error.message, 'err', error.hint);
        }
      };
      trial.addEventListener('click', () => run('trial'));
      execute.addEventListener('click', () => run('full'));
    },
  });
}

export function openGroupSettings(groupIds, progressElement) {
  if (!groupIds.length) { toast('请先选择群聊', 'warn'); return; }
  let diff = null;
  let revision = 0;
  openDrawer({ title: `群设置 · ${groupIds.length} 个群`, wide: true,
    body: `<p class="scope-description">${names(groupIds).map(esc).join('、')}</p><div class="settings-form-grid">
      <div class="field"><label>已保存模板</label><select class="input" id="setting-saved"><option value="">选择模板</option>${(state.config?.templates || []).map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select></div>
      <div class="field"><label>模板名称</label><input class="input" data-setting="name" value="群设置模板"/></div>
      <div class="field"><label>群名称</label><input class="input" data-setting="group_name" placeholder="留空不修改，可用 {group_name} {group_id}"/></div>
      <div class="field"><label>群头像</label><input class="input" data-setting="portrait" placeholder="本地路径或图片地址，留空不修改"/></div>
      <div class="field"><label>全员禁言</label><select class="input" data-setting="whole_ban"><option value="keep">不修改</option><option value="on">开启</option><option value="off">关闭</option></select></div>
      <div class="field"><label>通过群号搜索</label><select class="input" data-setting="search_option"><option value="keep">不修改</option><option value="on">允许</option><option value="off">禁止</option></select></div>
      <div class="field"><label>加群方式</label><select class="input" id="setting-add-mode"><option value="keep">不修改</option><option value="open">直接加入</option><option value="question">回答问题</option></select></div>
      <div class="field"><label>验证问题</label><input class="input" id="setting-question"/></div><div class="field"><label>答案</label><input class="input" id="setting-answer"/></div>
      <div class="field settings-wide"><label>群公告</label><textarea class="textarea" data-setting="notice" rows="3" placeholder="留空不发布"></textarea></div></div>
      <div id="setting-diff"></div>`,
    footer: '<span class="rename-error" role="alert"></span><label class="check-inline"><input type="checkbox" id="setting-confirm"/>已核对目标群与差异</label><span class="spacer"></span><button class="btn" data-close="1">关闭</button><button class="btn" id="setting-save">保存模板</button><button class="btn btn-primary" id="setting-preview">预演差异</button><button class="btn btn-primary" id="setting-execute" disabled>执行变更</button>',
    onMount(panel, foot) {
      const read = () => {
        const value = Object.fromEntries([...panel.querySelectorAll('[data-setting]')].map(input => [input.dataset.setting, input.value]));
        value.add_option = { mode: panel.querySelector('#setting-add-mode').value, question: panel.querySelector('#setting-question').value, answer: panel.querySelector('#setting-answer').value };
        return value;
      };
      const invalidate = () => { revision++; diff = null; foot.querySelector('#setting-execute').disabled = true; foot.querySelector('#setting-confirm').checked = false; panel.querySelector('#setting-diff').innerHTML = ''; };
      panel.addEventListener('input', invalidate);
      panel.addEventListener('change', invalidate);
      panel.querySelector('#setting-saved').addEventListener('change', event => {
        const saved = state.config.templates.find(item => item.id === event.target.value);
        if (!saved) return;
        panel.querySelectorAll('[data-setting]').forEach(input => { input.value = saved[input.dataset.setting] ?? ''; });
        panel.querySelector('#setting-add-mode').value = saved.add_option?.mode || 'keep';
        panel.querySelector('#setting-question').value = saved.add_option?.question || '';
        panel.querySelector('#setting-answer').value = saved.add_option?.answer || '';
      });
      foot.querySelector('#setting-save').addEventListener('click', async () => {
        try { const data = await api.post('/api/templates', { template: read() }); state.config = { ...state.config, ...data.config }; toast('群设置模板已保存', 'ok'); }
        catch (error) { foot.querySelector('.rename-error').textContent = error.message; }
      });
      foot.querySelector('#setting-preview').addEventListener('click', async () => {
        const ticket = revision;
        try {
          const data = await api.post('/api/settings/preview', { group_ids: groupIds, template: read() });
          if (ticket !== revision || !panel.isConnected) return;
          diff = data;
          panel.querySelector('#setting-diff').innerHTML = `<div class="preview-summary"><strong>${diff.total_changes} 项变更</strong><span>${diff.groups.length} 个群</span></div>${diff.warnings.map(warning => `<p class="text-warn small">${esc(warning)}</p>`).join('')}${diff.groups.map(group => `<section class="setting-group-diff"><h3>${esc(group.group_name)}</h3>${group.fields.map(field => `<div class="setting-diff-line"><span>${esc(field.label)}</span><span class="old-value">${esc(field.from)}</span><span>→ ${esc(field.to)}</span><small>${!field.supported ? '不支持' : field.note ? esc(field.note) : field.changed ? '将修改' : '无需修改'}</small></div>`).join('')}</section>`).join('')}`;
          foot.querySelector('#setting-execute').disabled = !diff.total_changes || !foot.querySelector('#setting-confirm').checked;
        } catch (error) { foot.querySelector('.rename-error').textContent = `${error.message} ${error.hint || ''}`; }
      });
      foot.querySelector('#setting-confirm').addEventListener('change', event => { foot.querySelector('#setting-execute').disabled = !event.target.checked || !diff?.total_changes; });
      foot.querySelector('#setting-execute').addEventListener('click', async () => {
        if (!diff?.total_changes || !foot.querySelector('#setting-confirm').checked) return;
        try {
          foot.querySelector('#setting-execute').disabled = true;
          const data = await api.post('/api/settings/execute', { group_ids: groupIds, template: diff.template, confirmed: true, interval: state.config?.batch?.interval });
          closeDrawer(); await api.pollJob(data.job.id, job => jobBanner(progressElement, job));
        } catch (error) { if (foot.isConnected) { foot.querySelector('.rename-error').textContent = error.message; foot.querySelector('#setting-execute').disabled = false; } else toast(error.message, 'err'); }
      });
    },
  });
}
