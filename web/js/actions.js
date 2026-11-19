import * as api from './api.js';
import { state } from './state.js';
import { esc, openDrawer, closeDrawer, toast, fmtDuration } from './ui.js';
import { clone, fieldSelectOptions, regexHelpLink } from './filters.js';
import { requestData, jobBanner, names, errorBox } from './workspace.js';
import { ResultTable } from './result-table.js';
import { groupTag, fieldStatusTag } from './field-display.js';

export function openRename(querySpec, progressElement, onFinish, defaults = {}) {
  const sources = querySpec.scope?.source_group_ids || [];
  const trialSize = Number(state.config?.batch?.trial_size) || 10;
  let plan = null;
  let mapping = {};
  let revision = 0;
  openDrawer({ title: '批量改群昵称', wide: true,
    body: `<div class="rename-layout"><form class="rename-form" onsubmit="return false">
      <div class="field"><label>生成方式</label><select class="input" id="rename-method"><option value="sync" ${sources.length ? '' : 'disabled'}>从来源群同步</option><option value="template" ${sources.length ? '' : 'selected'}>按变量模板</option><option value="mapping">按 CSV 名单</option></select></div>
      <div class="rename-source-note"><span class="eyebrow">昵称来源优先级</span><p>${sources.length ? names(sources).map((name, index) => `${index+1}. ${groupTag(name,sources[index])}`).join('<br>') : '尚未选择昵称来源群。'}</p></div>
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
      <p class="tiny faint">同步方式只修改选定目标群，来源群只读。正则未匹配、空结果、无权限和相同昵称会在预演中跳过。</p>
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
        panel.querySelector('.rename-source-note').hidden = method !== 'sync';
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
      let previewList;
      panel.querySelector('#rename-method').value = defaults.method || (sources.length ? 'sync' : 'template');
      panel.querySelector('#rename-source').value = defaults.source_field || querySpec.source_field || 'member.card';
      panel.querySelector('#rename-template').value = panel.querySelector('#rename-method').value === 'template' ? '{nickname}' : '{result}';
      panel.querySelector('#rename-file-field').hidden = panel.querySelector('#rename-method').value !== 'mapping';
      panel.querySelector('.rename-source-note').hidden = panel.querySelector('#rename-method').value !== 'sync';
      let tab = 'items';
      function paint() {
        previewList?.destroy();
        result.innerHTML = `<div class="preview-summary"><strong>${plan.stats.people} 人</strong><span>${plan.stats.change} 条待修改</span><span>${plan.stats.skip} 条跳过</span><span>预计 ${fmtDuration(plan.eta_seconds)}</span></div>
          ${plan.warnings.length ? `<details class="warning-details"><summary>注意事项 ${plan.warnings.length}</summary>${plan.warnings.map(warning => `<p>${esc(warning)}</p>`).join('')}</details>` : ''}
          <div class="view-tabs"><button class="${tab === 'items' ? 'active' : ''}" data-preview-tab="items">待修改</button><button class="${tab === 'skipped' ? 'active' : ''}" data-preview-tab="skipped">跳过原因</button></div><div id="rename-diff-list" class="preview-result-list"></div>`;
        const columns = [
          { key:'person',label:'群 / 成员',width:300,pinned:true,render:item=>`<div class="preview-cell"><strong>${groupTag(item.group_name,item.group_id)}</strong><small>${esc(item.nickname||item.display_name||'')} · ${esc(item.qq)}</small></div>` },
          ...(tab==='items' ? [
            { key:'source',label:'采用的来源',width:240,render:item=>`<div class="preview-cell"><strong title="${esc((item.source_values||[]).map(source=>`${source.name} → ${source.text}`).join('\n'))}">${item.source_group_name?groupTag(item.source_group_name,item.source_group_id):fieldStatusTag('模板 / CSV','neutral')}</strong><small title="${esc(item.source_text)}">${esc(item.source_text)}</small>${item.source_conflict?'<small class="text-warn">来源有差异，按优先级采用</small>':''}</div>` },
            { key:'change',label:'旧群昵称 → 新群昵称',width:300,render:item=>`<div class="preview-cell"><span class="old-value">${esc(item.old_card||'（空）')}</span><strong class="new-value">→ ${esc(item.new_card)}</strong>${item.clamped?'<small class="text-warn">已截断至 40 字符</small>':''}</div>` }
          ] : [{ key:'reason',label:'跳过原因',width:420,render:item=>esc(item.reason) }])
        ];
        previewList = new ResultTable(result.querySelector('#rename-diff-list'),{ columns,layoutKey:`rename-preview:${tab}`,rowHeight:92 });
        previewList.setLocal(plan[tab].map((item,index)=>({...item,id:`${item.group_id}:${item.qq}:${index}`})));
        result.querySelectorAll('[data-preview-tab]').forEach(button=>button.addEventListener('click',()=>{tab=button.dataset.previewTab;paint();}));
      }
      previewButton.addEventListener('click', async () => {
        const ticket = revision;
        const spec = clone(querySpec);
        spec.source_field = options().source_field;
        if (panel.querySelector('#rename-only-empty').checked) spec.filter = { op: 'and', rules: [spec.filter, { field: 'member.card', op: 'empty' }] };
        previewButton.disabled = true; foot.querySelector('.rename-error').textContent = '';
        try {
          const data = await requestData('/api/rename/preview', { query: spec, options: options(), interval: Number(panel.querySelector('#rename-interval').value) }, job => jobBanner(panel.querySelector('#rename-read-progress'), job));
          if (ticket !== revision || !panel.isConnected) return;
          plan = data; tab = 'items'; paint();
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

export { openGroupSettings } from './group-settings.js';
