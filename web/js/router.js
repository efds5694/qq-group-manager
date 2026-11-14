// 极简 hash 路由，单独成模块避免视图与 app.js 循环依赖

const ROUTES = ['connect', 'groups', 'members', 'cards', 'settings', 'tasks'];

export function currentRoute() {
  const raw = (window.location.hash || '').replace(/^#\/?/, '').split('?')[0];
  return ROUTES.includes(raw) ? raw : 'connect';
}

export function navigate(name) {
  if (!ROUTES.includes(name)) name = 'connect';
  const target = `#/${name}`;
  if (window.location.hash === target) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  window.location.hash = target;
}
