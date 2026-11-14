// 任务中心：执行进度、逐条结果、快照回滚、审计日志

import * as api from '../api.js';
import { state } from '../state.js';
import { navigate } from '../router.js';
import {
  toast, esc, openDrawer, closeDrawer, confirmAction, statusTag, fmtDuration, fmtNumber, emptyState,
} from '../ui.js';

const KIND_LABEL = { card: '批量改名', settings: '群设置', rollback: '回滚' };

function jobCard(job) {
  const total = job.total || 1;
  const done = job.ok + job.fail;
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
        <span class="mono tiny">${done}/${job.total} · 成功 ${job.ok} · 失败 ${job.fail}</span>
        <span class="row" style="gap:6px">
          <span class="tiny faint">${esc(job.created_text || '')}</span>
          <button class="btn btn-sm" data-job="${esc(job.id)}" type="button">详情</button>
        </span>
      </div>
    </div>`;
}

async function showJob(jobId) {
  try {
    const job = await api.get(`/api/jobs/${jobId}`);
    const items = job.items || [];
    openDrawer({
      title: `任务详情 · ${job.title}`,
      body: `
        <div class="grid grid-4">
          <div class="stat"><span class="label">总数</span><span class="value">${job.total}</span></div>
          <div class="stat"><span class="label">成功</span><span class="value ok">${job.ok}</span></div>
          <div class="stat"><span class="label">失败</span><span class="value danger">${job.fail}</span></div>
          <div class="stat"><span class="label">状态</span><span class="value" style="font-size:14px">${statusTag(job.status)}</span></div>
        </div>
        ${job.meta?.snapshot_id ? `<div class="hint-box"><span class="hint-icon">i</span><div>本次操作快照：<span class="mono">${esc(job.meta.snapshot_id)}</span>，可在下方快照列表回滚。</div></div>` : ''}
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
                        <td>${item.ok ? '<span class="tag tag-ok">成功</span>' : `<span class="tag tag-danger">失败</span> <span class="tiny muted">${esc(item.message)}</span>`}</td>
                        <td class="mono num">${item.ms} ms</td>
                      </tr>`
                      )
                      .join('')}
                  </tbody>
                </table>
              </div>`
            : '<p class="small faint">还没有逐条结果。</p>'
        }`,
      footer: `
        ${job.status === 'running' ? '<button class="btn btn-danger" id="drawer-cancel" type="button">中止任务</button>' : ''}
        <button class="btn" data-close="1" type="button">关闭</button>`,
      onMount: (body, foot) => {
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
  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>任务中心</h1>
          <p>执行进度、逐条结果与快照回滚。任务记录保存在内存里，重启服务后清空。</p>
        </div>
        <div class="page-actions">
          <button class="btn" id="btn-refresh-all" type="button">刷新</button>
        </div>
      </div>

      <div class="split" style="grid-template-columns:minmax(0,1.15fr) minmax(0,1fr)">
        <div style="display:flex;flex-direction:column;gap:14px">
          <div class="card">
            <div class="card-head"><h3>任务</h3><span class="sub" id="job-count">—</span></div>
            <div class="card-body" id="job-list" style="display:flex;flex-direction:column;gap:10px">
              <div class="skeleton" style="height:80px"></div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>快照</h3><span class="sub">改名片前的原始名片</span></div>
            <div class="card-body" id="snapshot-list" style="display:flex;flex-direction:column;gap:8px">
              <div class="skeleton" style="height:60px"></div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>审计日志</h3><span class="sub">最近 200 条</span></div>
          <div class="card-body tight" id="log-list">
            <div class="skeleton" style="height:200px"></div>
          </div>
        </div>
      </div>
    </div>`;

  const jobList = root.querySelector('#job-list');
  const snapList = root.querySelector('#snapshot-list');
  const logList = root.querySelector('#log-list');

  const loadJobs = async () => {
    try {
      const data = await api.get('/api/jobs');
      root.querySelector('#job-count').textContent = `${data.jobs.length} 个`;
      jobList.innerHTML = data.jobs.length
        ? data.jobs.map(jobCard).join('')
        : emptyState('还没有执行过任务', '批量改名或套用群设置后，进度会出现在这里。');
      jobList.querySelectorAll('[data-job]').forEach((node) => {
        node.addEventListener('click', () => showJob(node.dataset.job));
      });
    } catch (error) {
      jobList.innerHTML = `<div class="hint-box danger"><span class="hint-icon">!</span><div>${esc(error.message)}</div></div>`;
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
            title: '确认回滚名片',
            message: '将把快照里的成员名片逐个恢复为改动前的值。',
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

  root.querySelector('#btn-refresh-all').addEventListener('click', async () => {
    await Promise.all([loadJobs(), loadSnapshots(), loadLogs()]);
    toast('已刷新', 'ok');
  });

  await Promise.all([loadJobs(), loadSnapshots(), loadLogs()]);
}

export async function refresh() {
  await render(document.getElementById('view'));
}
