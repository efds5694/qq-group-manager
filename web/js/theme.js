import { loadPrefs, savePrefs } from './state.js';

let preference = 'system';
let media;

export function themePreference(value) {
  return ['light', 'dark'].includes(value) ? value : 'system';
}

export function resolveTheme(value, systemDark) {
  const mode = themePreference(value);
  return mode === 'system' ? systemDark ? 'dark' : 'light' : mode;
}

export function syncThemeControls(root = document) {
  root.querySelectorAll('[data-theme-select]').forEach(select => { select.value = preference; });
}

function applyTheme() {
  document.documentElement.dataset.theme = resolveTheme(preference, media.matches);
  syncThemeControls();
}

export function setTheme(value) {
  preference = themePreference(value);
  savePrefs({ theme: preference });
  applyTheme();
}

export function initializeTheme() {
  preference = themePreference(loadPrefs().theme);
  media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', () => { if (preference === 'system') applyTheme(); });
  document.addEventListener('change', event => {
    if (event.target.matches('[data-theme-select]')) setTheme(event.target.value);
  });
  applyTheme();
}
