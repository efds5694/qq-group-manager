import { state } from './state.js';

const ROUTES = ['groups', 'members', 'tasks', 'preferences'];
const ALIASES = { connect: 'preferences', settings: 'groups', cards: 'members', 'cross-members': 'members' };

export function currentRoute() {
  const raw = (window.location.hash || '').replace(/^#\/?/, '').split('?')[0];
  if (raw === 'cross-members') state.workbenchMode = 'people';
  if (raw === 'cards') state.pendingRename = true;
  if (raw === 'settings') state.pendingGroupSettings = true;
  return ALIASES[raw] || (ROUTES.includes(raw) ? raw : state.connected ? 'groups' : 'preferences');
}

export function navigate(name) {
  const route = ALIASES[name] || (ROUTES.includes(name) ? name : 'preferences');
  const target = `#/${route}`;
  if (window.location.hash === target) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else window.location.hash = target;
}
