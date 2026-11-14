// 应用外壳：路由分发、顶栏状态、导航高亮

import * as api from './api.js';
import { state, subscribe, setSession, loadPrefs, groupDisplayName } from './state.js';
import { currentRoute } from './router.js';
import { toast, esc } from './ui.js';

import * as connectView from './views/connect.js';
import * as groupsView from './views/groups.js';
import * as membersView from './views/members.js';
import * as cardsView from './views/cards.js';
import * as settingsView from './views/settings.js';
import * as tasksView from './views/tasks.js';

const VIEWS = {
  connect: { mod: connectView, title: '连接', sub: '配置协议端地址与令牌' },
  groups: { mod: groupsView, title: '群组', sub: '选择要管理的群' },
  members: { mod: membersView, title: '成员', sub: '查看与导出群成员' },
  cards: { mod: cardsView, title: '批量改名', sub: '按模板统一群名片，先预演再执行' },
  settings: { mod: settingsView, title: '群设置', sub: '把一套设置套用到多个群' },
  tasks: { mod: tasksView, title: '任务中心', sub: '执行进度、审计日志与快照回滚' },
};

const viewRoot = document.getElementById('view');
const navRoot = document.getElementById('nav');
const crumbTitle = document.getElementById('crumb-title');
const crumbSub = document.getElementById('crumb-sub');
const connStatus = document.getElementById('conn-status');
const selfPill = document.getElementById('self-pill');
const groupPill = document.getElementById('group-pill');
const refreshBtn = document.getElementById('refresh-btn');

let activeRoute = 'connect';

function highlightNav(route) {
  navRoot?.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.view === route);
  });
}

function renderTopbar() {
  const session = state.session;
  if (state.connected && session?.login) {
    connStatus.className = 'status on';
    connStatus.innerHTML = `<i class="dot dot-on"></i><span>已连接</span>`;
    selfPill.textContent = `${session.login.nickname || '未知'}（${session.login.user_id}）`;
    selfPill.title = `${session.adapter_label || 'OneBot'} · ${session.login.base_url || ''}`;
  } else {
    connStatus.className = 'status';
    connStatus.innerHTML = `<i class="dot dot-idle"></i><span>未连接</span>`;
    selfPill.textContent = '—';
  }
  groupPill.textContent = state.group ? groupDisplayName(state.group) : '未选群';
  groupPill.title = state.group ? `群号 ${state.group.group_id}` : '还没有选择群';

  crumbTitle.textContent = VIEWS[activeRoute]?.title || '连接';
  crumbSub.textContent = state.group && ['members', 'cards'].includes(activeRoute)
    ? `${groupDisplayName(state.group)} · ${state.group.group_id}`
    : VIEWS[activeRoute]?.sub || '';
}

async function renderRoute() {
  activeRoute = currentRoute();
  highlightNav(activeRoute);
  renderTopbar();

  if (!viewRoot) return;
  viewRoot.innerHTML = '<div class="page"><div class="skeleton" style="height:120px"></div></div>';

  const view = VIEWS[activeRoute];
  try {
    await view.mod.render(viewRoot);
  } catch (error) {
    console.error(error);
    viewRoot.innerHTML = `
      <div class="page">
        <div class="card"><div class="card-body">
          <div class="hint-box danger">
            <span class="hint-icon">!</span>
            <div><strong>页面加载失败</strong><br>${esc(error.message || error)}
            ${error.hint ? `<br><span class="faint">${esc(error.hint)}</span>` : ''}</div>
          </div>
        </div></div>
      </div>`;
  }
}

async function bootstrap() {
  // 先把配置拉下来，其它视图才有默认值
  try {
    const config = await api.get('/api/config');
    state.config = config;
    if (config.active?.base_url) {
      document.title = `QQ 群管理工具 · ${config.active.name}`;
    }
  } catch (error) {
    toast(error.message || '无法读取配置', 'err', error.hint);
  }

  // 已配置就直接探一次连接，失败不打扰（连接页会展示细节）
  try {
    const config = state.config;
    if (config && (config.active.has_token || config.active.base_url)) {
      const data = await api.get('/api/capabilities');
      setSession(data);
    }
  } catch (error) {
    state.connected = false;
  }

  refreshBtn?.addEventListener('click', async () => {
    const view = VIEWS[activeRoute];
    if (view.mod.refresh) {
      try {
        await view.mod.refresh();
        toast('已刷新', 'ok');
      } catch (error) {
        toast(error.message || '刷新失败', 'err', error.hint);
      }
    } else {
      await renderRoute();
    }
  });

  const prefs = loadPrefs();
  if (!window.location.hash) {
    window.location.hash = `#/${prefs.lastView || 'connect'}`;
    return; // 由 hashchange 触发首次渲染，避免重复渲染
  }
  await renderRoute();
}

let rendering = false;

window.addEventListener('hashchange', async () => {
  if (rendering) return;
  rendering = true;
  try {
    await renderRoute();
  } finally {
    rendering = false;
  }
});

subscribe(() => renderTopbar());
bootstrap();
