import * as api from './api.js';
import { state, subscribe, setSession, loadPrefs, savePrefs } from './state.js';
import { currentRoute } from './router.js';
import { esc, toast, closeDrawer } from './ui.js';
import { jobBanner } from './workspace.js';
import { initializeTheme } from './theme.js';
import * as groups from './views/groups.js';
import * as members from './views/members.js';
import * as rosters from './views/rosters.js';
import * as tasks from './views/tasks.js';
import * as preferences from './views/preferences.js';

const views = { groups: { title: '群聊', mod: groups }, members: { title: '人员总览', mod: members },
  'members/rename': { title: '改群昵称', mod: members }, lists: { title: '入群跟踪', mod: rosters },
  'lists/compare': { title: '群关系核对', mod: members },
  tasks: { title: '任务', mod: tasks }, preferences: { title: '设置', mod: preferences } };
const root = document.getElementById('view');
let route = 'preferences';
let revision = 0;
let rendering = false;
let pending = false;

function shell() {
  document.title = views[route].title + ' · 群务工作台';
  document.querySelectorAll('[data-view]').forEach(link => {
    const active = link.dataset.view === route.split('/')[0];
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  const status = document.getElementById('conn-status');
  status.className = `status ${state.connected ? 'on' : ''}`;
  status.innerHTML = `<i class="dot ${state.connected ? 'dot-on' : 'dot-idle'}"></i><span>${state.connected ? '已连接' : '未连接'}</span>`;
  const account = document.getElementById('self-pill');
  account.textContent = state.connected ? `${state.session.login.nickname} · ${state.session.login.user_id}` : '在设置中连接协议端';
  account.title = account.textContent;
}

async function renderRoute() {
  const token = ++revision;
  views[route].mod.dispose?.();
  route = currentRoute(); shell(); closeDrawer(); savePrefs({ lastView: route });
  root.innerHTML = '<div class="page"><div class="skeleton" style="height:160px"></div></div>';
  try { await views[route].mod.render(root, route); }
  catch (error) {
    if (token !== revision) return;
    root.innerHTML = `<div class="page"><div class="query-error"><strong>${esc(error.message || '页面读取失败')}</strong><p>${esc(error.hint || '可到设置检查连接，或刷新重试。')}</p><a class="btn" href="#/preferences">打开设置</a></div></div>`;
  }
}

async function scheduleRender() {
  pending = true;
  if (rendering) return;
  rendering = true;
  try { while (pending) { pending = false; await renderRoute(); } }
  finally { rendering = false; }
}

async function bootstrap() {
  const progress = root.querySelector('#bootstrap-progress');
  const stage = {kind:'load', status:'running', title:'加载连接配置', started_at:Date.now()/1000};
  jobBanner(progress, stage);
  const timer = setInterval(() => jobBanner(progress, stage), 1000);
  try {
    try { state.config = await api.get('/api/config'); }
    catch (error) { toast(error.message, 'err'); }
    stage.title = '连接协议端并读取账号资料'; jobBanner(progress, stage);
    try { setSession(await api.get('/api/capabilities')); }
    catch (error) { state.connected = false; }
  } finally { clearInterval(timer); }
  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-refresh-view]');
    if (!button) return;
    button.disabled = true;
    try { if (views[route].mod.refresh) await views[route].mod.refresh(); else await scheduleRender(); }
    catch (error) { toast(error.message, 'err', error.hint); }
    finally { button.disabled = false; }
  });
  if (!window.location.hash) {
    const firstView = loadPrefs().lastView || (state.connected ? 'groups' : 'preferences');
    window.history.replaceState(window.history.state, '', `#/${firstView}`);
  }
  window.addEventListener('hashchange', scheduleRender);
  await scheduleRender();
}

initializeTheme();
subscribe(shell);
bootstrap();
