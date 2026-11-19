import * as api from '../api.js';
import { state } from '../state.js';
import { toast, esc, bindTabs } from '../ui.js';
import { syncThemeControls } from '../theme.js';
import { FilterBar, loadCatalog } from '../filters.js';
import * as connect from './connect.js';

export async function render(root) {
  const tabs = [['appearance', '外观'], ['connection', '连接'], ['filters', '筛选预设'], ['batch', '批量参数']];
  root.innerHTML = `<div class="page preferences-page"><div class="page-head"><h1>设置</h1><button class="btn" data-refresh-view>刷新</button></div>
    <div class="section-tabs" role="tablist" aria-label="设置分类">${tabs.map(([id, label]) => `<button role="tab" id="pref-tab-${id}" aria-controls="pref-panel-${id}" data-panel-tab="${id}">${label}</button>`).join('')}</div>
    ${tabs.map(([id]) => `<section role="tabpanel" id="pref-panel-${id}" aria-labelledby="pref-tab-${id}" data-tab-panel="${id}" hidden></section>`).join('')}</div>`;
  const panel = id => root.querySelector(`#pref-panel-${id}`);
  panel('appearance').innerHTML = `<section class="workspace-card"><div class="card-head"><h3>界面主题</h3></div><div class="card-body appearance-settings"><label for="appearance-theme">显示模式<select class="input" id="appearance-theme" data-theme-select><option value="system">跟随系统</option><option value="light">日间模式</option><option value="dark">夜间模式</option></select></label><p class="muted">跟随系统会随设备的深浅色设置自动切换。选择保存在当前浏览器中。</p></div></section>`;
  syncThemeControls(root);
  bindTabs(root, state.connected ? 'appearance' : 'connection');
  panel('connection').innerHTML = '<div class="skeleton table-loading"></div>';
  panel('filters').innerHTML = '<section class="workspace-card"><div class="card-head"><h3>共享筛选预设</h3><span class="tiny muted">编辑内置规则，或保存自己的常用条件</span></div><div class="card-body" id="preferences-filters"></div></section>';
  const results = await Promise.allSettled([
    connect.render(panel('connection'), { embedded: true }),
    loadCatalog(true).then(() => new FilterBar(root.querySelector('#preferences-filters'))),
  ]);
  results.forEach((result, index) => {
    if (result.status === 'rejected') panel(index ? 'filters' : 'connection').innerHTML = `<div class="hint-box danger">${esc(result.reason.message)}</div>`;
  });
  const batch = state.config?.batch || {};
  panel('batch').innerHTML = `<section class="workspace-card"><div class="card-head"><h3>批量操作默认参数</h3></div><form class="card-body runtime-settings"><label>每条间隔（秒）<input class="input" id="preferences-interval" type="number" min="0.8" max="10" step="0.2" value="${Number(batch.interval) || 2}"/></label><label>失败重试次数<input class="input" id="preferences-retries" type="number" min="0" max="5" value="${Number(batch.retries) || 0}"/></label><label>试改条数<input class="input" id="preferences-trial" type="number" min="1" max="100" value="${Number(batch.trial_size) || 10}"/></label><button class="btn btn-primary" type="submit">保存参数</button></form></section>`;
  root.querySelector('.runtime-settings').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      state.config = await api.post('/api/config/preferences', { batch: { interval: root.querySelector('#preferences-interval').value,
        retries: root.querySelector('#preferences-retries').value, trial_size: root.querySelector('#preferences-trial').value } });
      toast('运行参数已保存', 'ok');
    } catch (error) { toast(error.message, 'err', error.hint); }
  });
}
