import * as api from './api.js';
import { state, subscribe, setSession, loadPrefs, savePrefs } from './state.js';
import { currentRoute } from './router.js';
import { esc, toast, closeDrawer } from './ui.js';
import * as groups from './views/groups.js';
import * as members from './views/members.js';
import * as tasks from './views/tasks.js';
import * as preferences from './views/preferences.js';

const views = { groups: { title: '群聊', mod: groups }, members: { title: '成员', mod: members },
  tasks: { title: '任务', mod: tasks }, preferences: { title: '设置', mod: preferences } };
const root = document.getElementById('view');
let route = 'preferences';
let revision = 0;
let rendering = false;
let pending = false;

function shell() {
  document.querySelectorAll('[data-view]').forEach(link => link.classList.toggle('active', link.dataset.view === route));
  document.getElementById('crumb-title').textContent = views[route].title;
  const status = document.getElementById('conn-status');
  status.className = `status ${state.connected ? 'on' : ''}`;
  status.innerHTML = `<i class="dot ${state.connected ? 'dot-on' : 'dot-idle'}"></i><span>${state.connected ? '已连接' : '未连接'}</span>`;
  document.getElementById('self-pill').textContent = state.connected ? `${state.session.login.nickname} · ${state.session.login.user_id}` : '尚未连接 NapCat';
}

async function renderRoute() {
  const token = ++revision;
  route = currentRoute(); shell(); closeDrawer(); savePrefs({ lastView: route });
  root.innerHTML = '<div class="page"><div class="skeleton" style="height:160px"></div></div>';
  try { await views[route].mod.render(root); }
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
  try { state.config = await api.get('/api/config'); }
  catch (error) { toast(error.message, 'err'); }
  try { setSession(await api.get('/api/capabilities')); }
  catch (error) { state.connected = false; }
  document.getElementById('refresh-btn').addEventListener('click', async () => {
    try { if (views[route].mod.refresh) await views[route].mod.refresh(); else await scheduleRender(); }
    catch (error) { toast(error.message, 'err', error.hint); }
  });
  if (!window.location.hash) { window.location.hash = `#/${loadPrefs().lastView || (state.connected ? 'groups' : 'preferences')}`; return; }
  await scheduleRender();
}

window.addEventListener('hashchange', scheduleRender);
subscribe(shell);
bootstrap();
