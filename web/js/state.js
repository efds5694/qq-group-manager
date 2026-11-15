// 全局状态：只存跨视图共享的数据，视图内部状态各自管理

const STORAGE_KEY = 'qqgm.prefs.v1';

export const state = {
  config: null,
  session: null,
  groups: [],
  group: null,
  members: null,
  selection: new Set(),
  plan: null,
  connected: false,
  caps: {},
  crossGroupTargets: null,
  workbenchGroups: null,
  workbenchMode: null,
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  listeners.forEach((fn) => {
    try {
      fn(state);
    } catch (error) {
      console.error(error);
    }
  });
}

export function update(patch) {
  Object.assign(state, patch);
  emit();
}

export function setSession(session) {
  state.session = session;
  state.connected = Boolean(session?.login?.user_id);
  state.caps = session?.capabilities || {};
  emit();
}

export function setGroups(groups) {
  state.groups = groups || [];
  emit();
}

export function selectGroup(group) {
  state.group = group || null;
  state.selection = new Set();
  state.members = null;
  state.plan = null;
  savePrefs({ lastGroupId: group?.group_id || '' });
  emit();
}

export function setMembers(payload) {
  state.members = payload || null;
  emit();
}

export function replaceSelection(set) {
  state.selection = set instanceof Set ? set : new Set(set || []);
  emit();
}

export function toggleSelection(qq) {
  const key = String(qq);
  if (state.selection.has(key)) state.selection.delete(key);
  else state.selection.add(key);
  emit();
}

export function clearSelection() {
  state.selection = new Set();
  emit();
}

/** 群显示名：开启「显示群备注」且有备注时，优先用备注 */
export function groupDisplayName(group) {
  if (!group) return '';
  const showRemark = loadPrefs().showRemark !== false;
  return (showRemark && group.group_remark) || group.group_name || '';
}

export function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch (error) {
    return {};
  }
}

export function savePrefs(patch) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
  } catch (error) {
    /* 忽略隐私模式下的写入失败 */
  }
}
