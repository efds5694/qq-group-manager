import { state } from './state.js';

const ROUTES = ['groups', 'members', 'members/rename', 'lists', 'lists/compare', 'tasks', 'preferences'];
const ALIASES = new Map([
  ['connect', 'preferences'], ['settings', 'groups'], ['cards', 'members/rename'],
  ['cross-members', 'members'], ['rosters', 'lists'], ['groups/rosters', 'lists'],
]);

export function currentRoute() {
  const hash = window.location.hash || '';
  const raw = hash.replace(/^#\/?/, '').split('?')[0];
  if (raw === 'cross-members') state.workbenchMode = 'people';
  if (raw === 'settings') state.pendingGroupSettings = true;
  const alias = ALIASES.get(raw);
  if (alias) {
    const query = hash.includes('?') ? hash.slice(hash.indexOf('?')) : '';
    window.history.replaceState(window.history.state, '', `#/${alias}${query}`);
    return alias;
  }
  return ROUTES.includes(raw) ? raw : state.connected ? 'groups' : 'preferences';
}

export function routeParams() {
  return new URLSearchParams(window.location.hash.split('?')[1] || '');
}

export function navigate(name, params) {
  const route = ROUTES.includes(name) || ALIASES.has(name) ? name : 'preferences';
  const suffix = params ? '?' + new URLSearchParams(params) : '';
  const target = `#/${route}${suffix}`;
  if (window.location.hash === target) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else window.location.hash = target;
}
