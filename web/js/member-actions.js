import * as api from './api.js';
import { state, setGroups } from './state.js';
import { openDrawer, closeDrawer, esc, downloadFile, toast } from './ui.js';
import { errorBox, jobBanner, requestData } from './workspace.js';
import { mountGroupSelect } from './search-controls.js';

const labels = { invite: '私发入群链接', ban: '禁言', kick: '移出成员' };
const matchLabels = { matched: '唯一匹配', review: '仅姓名相同', conflict: '需要核对', missing: '未匹配' };
const inviteChannels = { friend: '好友私聊', temporary: '非好友 · 需有可用的群临时会话', unknown: '未能读取好友关系' };

export function filePayload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ filename: file.name, file_base64: String(reader.result).split(',')[1] });
    reader.onerror = () => reject(new Error('无法读取名单文件，请重新选择。'));
    reader.readAsDataURL(file);
  });
}

export function openRosterMatch(sourceIds, onApply) {
  openDrawer({
    title: '按名单勾选', wide: true,
    body: '<div class="match-workspace"><p class="settings-help">在已选来源群中匹配全部成员。支持粘贴 Excel、WPS 或 Markdown 表格，也可以上传名单文件。</p>' +
      '<div class="roster-form"><label>名单文件<input class="input roster-file" type="file" id="match-file" accept=".csv,.tsv,.txt,.xlsx,.md"/></label>' +
      '<label>粘贴名单<textarea class="textarea mono" id="match-text" rows="4" placeholder="姓名&#9;班级&#9;学号&#9;手机号"></textarea></label></div>' +
      '<button class="btn" id="match-read">读取并匹配</button><div id="match-progress" hidden></div><div id="match-error"></div><div id="match-results"></div></div>',
    footer: '<button class="btn" data-close="1">取消</button><button class="btn btn-primary" id="match-apply" disabled>勾选匹配账号</button>',
    onMount(panel, foot) {
      const form = panel.querySelector('.match-workspace');
      const read = form.querySelector('#match-read');
      const file = form.querySelector('#match-file'), text = form.querySelector('#match-text');
      const host = form.querySelector('#match-results'), errorHost = form.querySelector('#match-error');
      const apply = foot.querySelector('#match-apply');
      const assignments = new Map();
      let preview, filter = 'all', page = 0, busy = false;
      const size = 25;
      const alive = () => form.isConnected && form.closest('.drawer')?.getAttribute('aria-hidden') === 'false';
      const sync = () => {
        const count = assignments.size;
        apply.textContent = count ? '勾选这 ' + count + ' 个账号' : '勾选匹配账号';
        apply.disabled = busy || !preview || !count;
        read.disabled = file.disabled = text.disabled = busy;
      };
      const invalidate = () => { preview = null; assignments.clear(); host.innerHTML = ''; errorHost.innerHTML = ''; sync(); };
      file.addEventListener('change', () => { text.value = ''; invalidate(); });
      text.addEventListener('input', () => { file.value = ''; invalidate(); });
      const unresolved = () => preview.rows.filter(row => !assignments.has(row.id));
      const paint = () => {
        const pending = unresolved();
        const rows = filter === 'pending' ? pending : preview.rows;
        const last = Math.max(0, Math.ceil(rows.length / size) - 1);
        page = Math.min(page, last);
        const shown = rows.slice(page * size, (page + 1) * size);
        host.innerHTML = '<div class="match-toolbar"><strong id="match-count"></strong><label>范围 <select class="input" id="match-filter"><option value="all">全部</option><option value="pending">待核对／未匹配</option></select></label>' +
          '<button class="btn btn-sm" id="match-export">导出未确认名单</button><span class="spacer"></span><button class="btn btn-sm" id="match-prev">上一页</button>' +
          '<span>' + (page + 1) + ' / ' + (last + 1) + '</span><button class="btn btn-sm" id="match-next">下一页</button></div>' +
          '<div class="table-wrap match-table"><table class="table"><thead><tr><th>名单人员</th><th>候选账号与依据</th><th>确认 QQ 号</th></tr></thead><tbody>' +
          shown.map(row => '<tr><td><strong>' + esc(row.name || row.input_qq || row.student || row.phone) + '</strong><div class="tiny muted">' +
            [row.class, row.student && '学号 ' + row.student, row.phone].filter(Boolean).map(esc).join(' · ') + '</div><span class="tag ' +
            (row.status === 'matched' ? 'tag-ok' : row.status === 'conflict' ? 'tag-danger' : '') + '">' + matchLabels[row.status] +
            '</span></td><td>' + (row.candidates.length ? '<select class="input" data-candidates="' + esc(row.id) + '" aria-label="选择候选 QQ 号">' +
              '<option value="">选择候选</option>' + row.candidates.map(candidate => '<option value="' + esc(candidate.qq) + '">' +
                esc(candidate.qq + ' · ' + candidate.evidence.map(item => item.field + ' · ' + item.group + ' · ' + (item.card || '无群昵称')).join('；')) +
                '</option>').join('') + '</select><small class="match-evidence tiny muted" data-evidence="' + esc(row.id) + '"></small>' : '—') +
            '</td><td><input class="input mono match-assignment" data-assignment="' + esc(row.id) + '" inputmode="numeric" aria-label="确认 QQ 号" value="' +
            esc(assignments.get(row.id) || '') + '" placeholder="输入来源群 QQ 号"/></td></tr>').join('') +
          '</tbody></table></div>';
        const status = () => {
          host.querySelector('#match-count').textContent = '已选 ' + assignments.size + ' / ' + preview.rows.length + ' 人';
          host.querySelector('#match-export').disabled = !unresolved().length;
          sync();
        };
        host.querySelector('#match-filter').value = filter;
        host.querySelector('#match-filter').onchange = event => { filter = event.target.value; page = 0; paint(); };
        host.querySelector('#match-prev').disabled = page === 0;
        host.querySelector('#match-next').disabled = page === last;
        host.querySelector('#match-prev').onclick = () => { page--; paint(); };
        host.querySelector('#match-next').onclick = () => { page++; paint(); };
        host.querySelector('#match-export').onclick = async () => {
          try {
            const response = await api.post('/api/members/match-roster/export', {
              preview_id: preview.preview_id, assignments: Object.fromEntries(assignments),
            });
            await downloadFile(response, '未确认名单.csv');
          } catch (error) { toast(error.message, 'err'); }
        };
        for (const row of shown) {
          const input = host.querySelector('[data-assignment="' + row.id + '"]');
          const picker = host.querySelector('[data-candidates="' + row.id + '"]');
          const evidence = host.querySelector('[data-evidence="' + row.id + '"]');
          const update = () => {
            const qq = input.value.trim();
            if (qq) assignments.set(row.id, qq); else assignments.delete(row.id);
            const candidate = row.candidates.find(item => item.qq === qq);
            if (picker) picker.value = candidate?.qq || '';
            if (evidence) evidence.textContent = candidate?.evidence.map(item => item.field + ' · ' + item.group + ' · ' + (item.card || '无群昵称')).join('；') || '';
            status();
          };
          input.oninput = update;
          if (picker) picker.onchange = () => { input.value = picker.value; update(); };
          update();
        }
        status();
      };
      read.onclick = async () => {
        invalidate(); busy = true; sync();
        try {
          const payload = file.files[0] ? await filePayload(file.files[0]) : { text: text.value };
          preview = await requestData('/api/members/match-roster', { ...payload, source_ids: sourceIds },
            job => jobBanner(form.querySelector('#match-progress'), job));
          if (!alive()) return;
          for (const row of preview.rows) if (row.suggested) assignments.set(row.id, row.suggested);
          page = 0; filter = 'all'; paint();
        } catch (error) { if (alive()) errorHost.innerHTML = errorBox(error); }
        finally { busy = false; if (alive()) sync(); }
      };
      apply.onclick = async () => {
        busy = true; sync(); errorHost.innerHTML = '';
        try {
          const result = await api.post('/api/members/match-roster/confirm', {
            preview_id: preview.preview_id, assignments: Object.fromEntries(assignments),
          });
          if (alive()) { closeDrawer(); await onApply(result); }
        } catch (error) { if (alive()) errorHost.innerHTML = errorBox(error); else toast(error.message, 'err', error.hint); }
        finally { busy = false; if (alive()) sync(); }
      };
    },
  });
}

export function openMemberAction(operation, scope, onStart) {
  const invite = operation === 'invite';
  const fixed = scope.group?.id;
  openDrawer({
    title: labels[operation], wide: true,
    body: '<div class="member-action-workspace"><p class="settings-help">' +
      (invite ? '逐人私发目标群链接。实际入群情况在「名单与邀请 → 入群跟踪」核对。' :
        '请核对操作群、成员和跳过原因，再执行变更。') + '</p>' +
      '<div class="roster-form">' +
      (fixed ? '<label>目标群<span>' + esc(scope.group.name + '（' + fixed + '）') + '</span></label>' :
        '<div id="member-action-group"></div>') +
      (invite && !fixed ? '<div><button class="btn btn-sm" id="invite-group-refresh" type="button">刷新群列表</button></div>' : '') +
      (operation === 'ban' ? '<label>禁言时长（分钟）<input class="input" id="member-action-duration" type="number" min="1" max="43200" value="10"/></label>' : '') +
      (invite ? '<details><summary>手动提供 QQ 群分享链接</summary><input class="input" id="member-action-link" aria-label="QQ 群分享链接" placeholder="从 QQ 复制入群链接"/></details>' +
        '<label id="member-action-message-wrap" hidden>私聊正文<textarea class="textarea" id="member-action-message" rows="3"></textarea></label>' : '') +
      '</div><button class="btn" id="member-action-preview">预演</button><div id="member-action-progress" hidden></div><div id="member-action-error"></div>' +
      '<div id="member-action-results"></div></div>',
    footer: '<button class="btn" data-close="1">取消</button>' +
      (invite && !fixed ? '<button class="btn" id="member-action-track" disabled>仅保存入群跟踪</button>' : '') + '<button class="btn ' +
      (operation === 'kick' ? 'btn-danger' : 'btn-primary') + '" id="member-action-execute" disabled>确认' + labels[operation] + '</button>',
    onMount(panel, foot) {
      const form = panel.querySelector('.member-action-workspace');
      const preview = form.querySelector('#member-action-preview');
      const execute = foot.querySelector('#member-action-execute');
      const track = foot.querySelector('#member-action-track');
      const groupHost = form.querySelector('#member-action-group'), link = form.querySelector('#member-action-link');
      const refresh = form.querySelector('#invite-group-refresh');
      const message = form.querySelector('#member-action-message'), duration = form.querySelector('#member-action-duration');
      const host = form.querySelector('#member-action-results'), errorHost = form.querySelector('#member-action-error');
      let group, plan, busy = false, reviewedLink = '';
      const alive = () => form.isConnected && form.closest('.drawer')?.getAttribute('aria-hidden') === 'false';
      const update = () => {
        preview.disabled = busy || !(fixed || group?.value);
        execute.disabled = busy || !plan?.ready || Boolean(plan.link_error);
        if (track) track.disabled = busy || !plan?.rows.length;
        group?.setDisabled(busy);
        for (const control of [refresh, link, message, duration]) if (control) control.disabled = busy;
      };
      const invalidate = () => { plan = null; host.innerHTML = ''; errorHost.innerHTML = ''; update(); };
      const resetMessage = () => {
        reviewedLink = '';
        if (message) { message.value = ''; form.querySelector('#member-action-message-wrap').hidden = true; }
        invalidate();
      };
      if (groupHost) group = mountGroupSelect(groupHost, {
        groups: invite ? state.groups : state.groups.filter(item => scope.sourceIds.includes(item.group_id)),
        label: invite ? '目标群' : '操作群', onChange: resetMessage,
      });
      refresh?.addEventListener('click', async () => {
        busy = true; errorHost.innerHTML = ''; update();
        try {
          const data = await requestData('/api/groups/load', { refresh: true },
            job => jobBanner(form.querySelector('#member-action-progress'), job));
          if (alive()) { setGroups(data.groups); group.setGroups(data.groups); }
        } catch (error) {
          if (alive()) errorHost.innerHTML = errorBox(error);
        } finally { busy = false; if (alive()) update(); }
      });
      link?.addEventListener('input', resetMessage);
      duration?.addEventListener('input', invalidate);
      message?.addEventListener('input', invalidate);
      preview.onclick = async () => {
        invalidate(); busy = true; update();
        try {
          plan = await requestData('/api/members/actions/preview', { ...scope.spec, operation, group_id: fixed || group.value,
            link: link?.value.trim() || reviewedLink, message: message?.value.trim(), duration: duration ? Number(duration.value) * 60 : undefined },
          job => jobBanner(form.querySelector('#member-action-progress'), job));
          if (!alive()) return;
          if (message && plan.message) {
            reviewedLink = plan.link;
            message.value = plan.message;
            form.querySelector('#member-action-message-wrap').hidden = false;
          }
          const skipped = plan.rows.filter(row => row.reason).length;
          const temporary = plan.rows.filter(row => row.channel === 'temporary').length;
          const summary = plan.link_error ? `${plan.rows.length - skipped} 人暂无可用入群链接`
            : `${invite ? '可尝试私发' : '可执行'} ${plan.ready} 人`;
          host.innerHTML = '<div class="match-toolbar"><strong>' + esc(plan.group_name) + '（' + esc(plan.group_id) +
            '）</strong><span>' + summary + ' · 跳过 ' + skipped + ' 人' +
            (temporary ? ' · ' + temporary + ' 人需临时会话' : '') + '</span></div>' +
            (plan.link_error ? errorBox({message: plan.link_error}) : '') +
            '<div class="table-wrap match-table"><table class="table"><thead><tr><th>QQ 号</th><th>昵称</th><th>预演结果</th></tr></thead><tbody>' +
            plan.rows.map(row => '<tr><td class="mono">' + esc(row.qq) + '</td><td>' + esc(row.label) + '</td><td>' +
              esc(row.reason || (plan.link_error ? '暂无法通过链接邀请' : inviteChannels[row.channel] || '将执行' + labels[operation])) +
              (!row.reason && ['unknown', 'sending'].includes(row.previous) ? '<div class="tiny muted">上次结果未知，请先确认对方是否收到。</div>' : '') +
              '</td></tr>').join('') +
            '</tbody></table></div>';
        } catch (error) { if (alive()) errorHost.innerHTML = errorBox(error); }
        finally { busy = false; if (alive()) update(); }
      };
      const submit = async (trackOnly) => {
        if (!plan || busy) return;
        busy = true; update();
        try {
          const result = await api.post('/api/members/actions/execute', { preview_id: plan.preview_id, track_only: trackOnly });
          if (alive()) closeDrawer();
          if (trackOnly) toast('已保存入群跟踪名单', 'ok', '可在 QQ 中手动处理，再回这里核对入群情况。');
          else toast('任务已提交', 'ok', '在「任务」查看逐人结果。');
          await onStart?.(result);
        } catch (error) { if (alive()) errorHost.innerHTML = errorBox(error); else toast(error.message, 'err', error.hint); }
        finally { busy = false; if (alive()) update(); }
      };
      execute.onclick = () => submit(false);
      if (track) track.onclick = () => submit(true);
      update();
    },
  });
}
