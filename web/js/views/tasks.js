// 任务中心：执行进度、逐条结果、快照回滚、审计日志

import * as api from '../api.js';
import { state } from '../state.js';
import { navigate } from '../router.js';
import {
  toast, esc, openDrawer, closeDrawer, confirmAction, statusTag, fmtDuration, fmtNumber, emptyState, bindTabs,
} from '../ui.js';

let reload;

const KIND_LABEL = { load: '资料读取', card: '改群昵称', settings: '群设置', rollback: '群昵称回滚', collect: '资料补全', member_action: '成员操作' };

function jobCard(job) {
  const total = job.total || 1;
  const done = job.cursor ?? job.ok + job.fail;
  return `
    <div class="job-item">
      <div class="job-top">
        <span class="tag tag-ghost">${esc(KIND_LABEL[job.kind] || job.kind)}</span>
        <span class="job-title" title="${esc(job.title)}">${esc(job.title)}</span>
        <span class="spacer"></span>
        ${statusTag(job.status)}
      </div>
      <div class="progress">
        <div class="bar-ok" style="width:${(job.ok / total) * 100}%"></div>
        <div class="bar-fail" style="width:${(job.fail / total) * 100}%"></div>
        <div class="bar-idle"></div>
      </div>
      <div class="progress-meta">
        <span class="mono tiny">${job.kind === 'load' ? `${esc(job.phase || '准备读取')} · ${job.total ? `${done}/${job.total}` : '读取中'}` : `${done}/${job.total} · 成功 ${job.ok} · 失败 ${job.fail}${job.skipped ? ' · 跳过 ' + job.skipped : ''}`}</span>
        <span class="row" style="gap:6px">
          <span class="tiny faint">${esc(job.created_text || '')}</span>
          <button class="btn btn-sm" data-job="${esc(job.id)}" type="button">详情</button>
        </span>
      </div>
    </div>`;
}

function jobDetails(job) {
  const items = job.items || [];
  return `
        <p class="tiny muted">${esc(job.phase || job.title)} · ${['pending','running'].includes(job.status) ? '每秒刷新执行进度' : '任务已结束'}</p><div class="grid grid-4">
          <div class="stat"><span class="label">总数</span><span class="value">${job.total}</span></div>
          <div class="stat"><span class="label">成功</span><span class="value ok">${job.ok}</span></div>
          <div class="stat"><span class="label">失败</span><span class="value danger">${job.fail}</span></div>
          <div class="stat"><span class="label">状态</span><span class="value" style="font-size:14px">${statusTag(job.status)}</span></div>
        </div>
        ${job.meta?.snapshot_id ? `<div class="hint-box"><span class="hint-icon">i</span><div>本次操作快照：<span class="mono">${esc(job.meta.snapshot_id)}</span>${job.kind === 'settings' ? '，仅供核对，不支持自动回滚。' : '，可在下方快照列表回滚。'}</div></div>` : ''}
        ${job.meta?.snapshot_ids?.length ? `<div class="hint-box"><span class="hint-icon">i</span><div>本次操作按目标群保存了 ${job.meta.snapshot_ids.length} 份快照，可在快照列表分别回滚：<br>${job.meta.snapshot_ids.map(id => `<span class="mono">${esc(id)}</span>`).join('<br>')}</div></div>` : ''}
        ${
          items.length
            ? `<div class="table-wrap" style="max-height:420px;border:1px solid var(--line)">
                <table class="table">
                  <thead><tr><th>#</th><th>目标</th><th>结果</th><th>耗时</th></tr></thead>
                  <tbody>
                    ${items
                      .map(
                        (item) => `
                      <tr>
                        <td class="mono num">${item.seq}</td>
                        <td><div class="name-cell">
                          <span class="primary-name">${esc(item.label || item.target)}</span>
                          <span class="secondary-name mono">${esc(item.action)}</span>
                        </div></td>
                        <td>${item.ok ? '<span class="tag tag-ok">成功</span>' : `<span class="tag ${item.skipped ? '' : 'tag-danger'}">${item.skipped ? '跳过' : '失败'}</span> <span class="tiny muted">${esc(item.message)}</span>`}</td>
                        <td class="mono num">${item.ms} ms</td>
                      </tr>`
                      )
                      .join('')}
                  </tbody>
                </table>
              </div>`
            : '<p class="small faint">还没有逐条结果。</p>'
        }`;
}

async function showJob(jobId) {
  try {
    const job = await api.get(`/api/jobs/${jobId}`);
    openDrawer({
      title: `任务详情 · ${job.title}`,
      body: `<div class="job-live-details">${jobDetails(job)}</div>`,
      footer: `
        ${['pending','running'].includes(job.status) ? '<button class="btn btn-danger" id="drawer-cancel" type="button">中止任务</button>' : ''}
        <button class="btn" data-close="1" type="button">关闭</button>`,
      onMount: (body, foot) => {
        const live = body.querySelector('.job-live-details');
        const active = () => live.isConnected && live.closest('.drawer')?.getAttribute('aria-hidden') === 'false';
        if (['pending','running'].includes(job.status)) api.pollJob(jobId, current => {
          const scroll = live.querySelector('.table-wrap')?.scrollTop || 0;
          const signature = `${current.cursor}:${current.status}:${current.phase}:${current.total}`;
          if (live.dataset.version === signature) return;
          live.dataset.version = signature;
          live.innerHTML = jobDetails(current);
          if (live.querySelector('.table-wrap')) live.querySelector('.table-wrap').scrollTop = scroll;
          const cancel = foot.querySelector('#drawer-cancel');
          if (cancel) cancel.hidden = !['pending','running'].includes(current.status);
        }, 1000, active).catch(error => { if (active()) toast(error.message, 'err'); });
        foot.querySelector('#drawer-cancel')?.addEventListener('click', async () => {
          try {
            await api.post(`/api/jobs/${jobId}/cancel`, {});
            toast('已请求中止', 'warn');
            closeDrawer();
          } catch (error) {
            toast(error.message, 'err');
          }
        });
      },
    });
  } catch (error) {
    toast(error.message, 'err', error.hint);
  }
}

export async function render(root) {
  const tabs = [['jobs', '执行记录'], ['snapshots', '快照'], ['logs', '审计日志']];
  root.innerHTML = `<div class="page tasks-page"><div class="page-head"><h1 tabindex="0" title="执行进度每秒刷新，重启后清空任务记录。">任务中心</h1><button class="btn" data-refresh-view>刷新</button></div>
    <div class="section-tabs" role="tablist" aria-label="任务分类">${tabs.map(([id, label]) => `<button role="tab" id="task-tab-${id}" aria-controls="task-panel-${id}" data-panel-tab="${id}">${label}</button>`).join('')}</div>
    <section class="card" role="tabpanel" id="task-panel-jobs" aria-labelledby="task-tab-jobs" data-tab-panel="jobs"><div class="card-head"><h3>执行记录</h3><span class="sub" id="job-count">—</span></div><div class="card-body task-record-list" id="job-list"><div class="skeleton" style="height:80px"></div></div></section>
    <section class="card" role="tabpanel" id="task-panel-snapshots" aria-labelledby="task-tab-snapshots" data-tab-panel="snapshots" hidden><div class="card-head"><h3>快照</h3><span class="sub">改群昵称前保存的原始资料</span></div><div class="card-body task-record-list" id="snapshot-list"><div class="skeleton" style="height:60px"></div></div></section>
    <section class="card" role="tabpanel" id="task-panel-logs" aria-labelledby="task-tab-logs" data-tab-panel="logs" hidden><div class="card-head"><h3>审计日志</h3><span class="sub">最近 200 条</span></div><div class="card-body tight" id="log-list"><div class="skeleton" style="height:200px"></div></div></section></div>`;
  bindTabs(root, 'jobs');

  const jobList = root.querySelector('#job-list');
  const snapList = root.querySelector('#snapshot-list');
  const logList = root.querySelector('#log-list');

  let jobsTimer, jobsPending = false;
  const loadJobs = async () => {
    if (!jobList.isConnected || jobsPending) return;
    clearTimeout(jobsTimer); jobsPending = true;
    const started = Date.now();
    try {
      const data = await api.get('/api/jobs');
      if (!jobList.isConnected) return;
      root.querySelector('#job-count').textContent = `${data.jobs.length} 个`;
      jobList.innerHTML = data.jobs.length
        ? data.jobs.map(jobCard).join('')
        : emptyState('还没有执行过任务', '批量改名或套用群设置后，进度会出现在这里。');
      jobList.querySelectorAll('[data-job]').forEach((node) => {
        node.addEventListener('click', () => showJob(node.dataset.job));
      });
    } catch (error) {
      jobList.innerHTML = `<div class="hint-box danger"><span class="hint-icon">!</span><div>${esc(error.message)}</div></div>`;
    } finally {
      jobsPending = false;
      if (jobList.isConnected) jobsTimer = setTimeout(loadJobs, Math.max(0, 1000 - (Date.now() - started)));
    }
  };

  const loadSnapshots = async () => {
    try {
      const data = await api.get('/api/snapshots');
      if (!data.snapshots.length) {
        snapList.innerHTML = emptyState('还没有快照', '执行批量改名时会自动保存一份，可随时回滚。');
        return;
      }
      snapList.innerHTML = data.snapshots
        .map(
          (snap) => `
        <div class="row" style="padding:9px 11px;border:1px solid var(--line);border-radius:10px">
          <div style="min-width:0;flex:1 1 auto">
            <div class="small strong" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(snap.group_name || snap.group_id || '—')}</div>
            <div class="tiny faint mono">${esc(snap.created_text)} · ${snap.count} 人 · ${esc(snap.kind)}</div>
          </div>
          ${
            snap.kind === 'cards'
              ? `<button class="btn btn-sm" data-rollback="${esc(snap.id)}" type="button">回滚</button>`
              : '<span class="tag tag-ghost">仅记录</span>'
          }
        </div>`
        )
        .join('');

      snapList.querySelectorAll('[data-rollback]').forEach((node) => {
        node.addEventListener('click', async () => {
          const ok = await confirmAction({
            title: '确认回滚群昵称',
            message: '将把快照里的成员群昵称逐个恢复为改动前的值。',
            hint: '回滚同样受速率限制，人数较多时需要较长时间。',
            confirmText: '开始回滚',
            danger: true,
          });
          if (!ok) return;
          try {
            const data = await api.post(`/api/snapshots/${node.dataset.rollback}/rollback`, {
              interval: state.config?.batch?.interval ?? 2,
            });
            toast(`回滚任务已开始：${data.planned} 人`, 'ok');
            await loadJobs();
            const job = await api.pollJob(data.job.id, () => {});
            toast(job.fail ? `回滚完成，失败 ${job.fail}` : '回滚完成', job.fail ? 'warn' : 'ok');
            await loadJobs();
            await loadSnapshots();
          } catch (error) {
            toast(error.message, 'err', error.hint);
          }
        });
      });
    } catch (error) {
      snapList.innerHTML = `<div class="hint-box danger"><span class="hint-icon">!</span><div>${esc(error.message)}</div></div>`;
    }
  };

  const loadLogs = async () => {
    try {
      const data = await api.get('/api/logs', { limit: 200 });
      if (!data.logs.length) {
        logList.innerHTML = emptyState('暂无日志', '连接、任务执行都会记录在这里。');
        return;
      }
      logList.innerHTML = `
        <div class="table-wrap" style="max-height:560px">
          <table class="table">
            <thead><tr><th>时间</th><th>类型</th><th>内容</th></tr></thead>
            <tbody>
              ${data.logs
                .map((log) => {
                  const extra = Object.entries(log)
                    .filter(([key]) => !['ts', 'kind'].includes(key))
                    .map(([key, value]) => `${key}=${value}`)
                    .join(' · ');
                  return `<tr>
                    <td class="mono num tiny nowrap">${esc(log.ts)}</td>
                    <td><span class="tag tag-ghost">${esc(log.kind)}</span></td>
                    <td class="tiny muted" style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(extra)}</td>
                  </tr>`;
                })
                .join('')}
            </tbody>
          </table>
        </div>`;
    } catch (error) {
      logList.innerHTML = `<div class="hint-box danger"><span class="hint-icon">!</span><div>${esc(error.message)}</div></div>`;
    }
  };

  reload = () => Promise.all([loadJobs(), loadSnapshots(), loadLogs()]);
  await reload();
}

export async function refresh() { await reload?.(); }
