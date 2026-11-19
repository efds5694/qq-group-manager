// 通用 UI：Toast、抽屉、确认框、格式化

const toastHost = document.getElementById('toast-host');

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function highlightText(value, query) {
  const text = String(value ?? '');
  const term = (query || '').trim();
  if (!term) return esc(text);
  const escaped = term.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  let out = '', end = 0;
  for (const match of text.matchAll(new RegExp(escaped, 'giu'))) {
    out += esc(text.slice(end, match.index)) + '<mark class="search-hit">' + esc(match[0]) + '</mark>';
    end = match.index + match[0].length;
  }
  return out + esc(text.slice(end));
}

export function toast(message, type = 'info', hint = '') {
  if (!toastHost) return;
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.innerHTML = `
    <span class="t-dot"></span>
    <span class="t-text">${esc(message)}${hint ? `<span class="t-hint">${esc(hint)}</span>` : ''}</span>
  `;
  toastHost.appendChild(node);
  const life = type === 'err' ? 6000 : 2800;
  window.setTimeout(() => {
    node.classList.add('fade-out');
    window.setTimeout(() => node.remove(), 220);
  }, life);
}

const drawer = document.getElementById('drawer');
const drawerTitle = document.getElementById('drawer-title');
const drawerBody = document.getElementById('drawer-body');
const drawerFoot = document.getElementById('drawer-foot');

export function openDrawer({ title, body, footer = '', onMount, wide = false }) {
  if (!drawer) return;
  closeMenus();
  drawerTitle.textContent = title;
  drawer.querySelector('.drawer-panel').classList.toggle('drawer-wide', wide);
  drawerBody.innerHTML = body;
  drawerFoot.innerHTML = footer;
  drawer.setAttribute('aria-hidden', 'false');
  document.getElementById('view')?.classList.add('is-scroll-locked');
  drawerFoot.querySelectorAll('[data-close]').forEach((node) => {
    node.addEventListener('click', closeDrawer);
  });
  onMount?.(drawerBody, drawerFoot);
}

export function closeDrawer() {
  if (!drawer) return;
  drawer.setAttribute('aria-hidden', 'true');
  document.getElementById('view')?.classList.remove('is-scroll-locked');
  window.setTimeout(() => {
    if (drawer.getAttribute('aria-hidden') === 'true') {
      drawerBody.innerHTML = '';
      drawerFoot.innerHTML = '';
    }
  }, 260);
}

drawer?.addEventListener('click', (event) => {
  if (event.target.dataset.close) closeDrawer();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    const menu = document.querySelector('details.action-menu[open]');
    if (menu) { closeMenus(); menu.querySelector('summary').focus(); }
    else closeDrawer();
  }
});

export const menuChevron = '<span class="menu-chevron" aria-hidden="true"></span>';

export function actionMenu(label, content, extraClass = '') {
  return `<details class="action-menu ${extraClass}"><summary class="btn btn-sm">${esc(label)}${menuChevron}</summary><div class="action-menu-panel">${content}</div></details>`;
}

function closeMenus(except) {
  document.querySelectorAll('details.action-menu[open]').forEach(menu => { if (menu !== except) menu.open = false; });
}

document.addEventListener('click', event => {
  const menu = event.target.closest('details.action-menu');
  closeMenus(menu);
  if (menu && event.target.closest('button') && !event.target.closest('[data-menu-keep]')) menu.open = false;
});

// 页内切换保留面板节点，避免丢失尚未提交的表单。
export function bindTabs(root, initial) {
  const buttons = [...root.querySelectorAll('[data-panel-tab]')];
  const show = key => {
    buttons.forEach(button => {
      const active = button.dataset.panelTab === key;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    root.querySelectorAll('[data-tab-panel]').forEach(panel => { panel.hidden = panel.dataset.tabPanel !== key; });
  };
  buttons.forEach((button, index) => {
    button.addEventListener('click', () => show(button.dataset.panelTab));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      show(buttons[next].dataset.panelTab); buttons[next].focus();
    });
  });
  show(initial);
}

/** 危险操作二次确认 */
export function confirmAction({ title, message, confirmText = '确认执行', danger = false, hint = '' }) {
  return new Promise((resolve) => {
    openDrawer({
      title,
      body: `
        <div class="hint-box ${danger ? 'danger' : 'warn'}">
          <span class="hint-icon">!</span>
          <div>${esc(message)}${hint ? `<br><span class="faint">${esc(hint)}</span>` : ''}</div>
        </div>`,
      footer: `
        <button class="btn" data-close="1" type="button">取消</button>
        <button class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" id="confirm-ok" type="button">${esc(confirmText)}</button>
      `,
      onMount: (body, foot) => {
        foot.querySelector('#confirm-ok')?.addEventListener('click', () => {
          closeDrawer();
          resolve(true);
        });
        foot.querySelector('[data-close]')?.addEventListener('click', () => resolve(false));
      },
    });
  });
}

export async function downloadFile(response, filename) {
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 复制文本到剪贴板：优先 Clipboard API，失败时退回 execCommand */
export async function copyText(text) {
  const value = String(text ?? '');
  if (!value) throw new Error('没有可复制的内容');

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (error) {
    /* 本地 http 或权限被拒时走下面的兜底 */
  }

  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (error) {
    ok = false;
  }
  area.remove();
  if (!ok) throw new Error('浏览器拒绝了复制操作，请改用「开始导出」下载文件');
  return true;
}

export function fmtDuration(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value < 60) return `${Math.round(value)} 秒`;
  const minutes = Math.floor(value / 60);
  const rest = Math.round(value % 60);
  if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

export function fmtNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
}

const dataDateFormat = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit',
  day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'});

export function dataTimeLabel(data) {
  if (!data.data_at) return '资料读取时间：未知';
  const start = dataDateFormat.format(new Date(data.data_at * 1000));
  const end = dataDateFormat.format(new Date((data.data_at_end || data.data_at) * 1000));
  return `资料读取时间：${start}${end !== start ? ` ～ ${end}` : ''}${data.stale ? ' · 旧缓存，可刷新' : ''}`;
}

export function roleTag(role) {
  const map = {
    owner: ['tag-owner', '群主'],
    admin: ['tag-admin', '管理员'],
    member: ['tag-member', '成员'],
  };
  const [cls, label] = map[role] || map.member;
  return `<span class="tag ${cls}">${label}</span>`;
}

export function statusTag(status) {
  const map = {
    pending: ['tag-ghost', '排队中'],
    running: ['tag-teal', '执行中'],
    done: ['tag-ok', '已完成'],
    failed: ['tag-danger', '有失败'],
    canceled: ['tag-ghost', '已中止'],
    paused: ['tag-ghost', '已暂停'],
  };
  const [cls, label] = map[status] || ['tag-ghost', status];
  return `<span class="tag ${cls}">${label}</span>`;
}

export function emptyState(title, description, icon = '') {
  return `
    <div class="empty">
      ${icon || '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 9h8M8 13h5"/></svg>'}
      <strong>${esc(title)}</strong>
      <p>${esc(description)}</p>
    </div>`;
}
