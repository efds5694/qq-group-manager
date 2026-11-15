import * as api from '../api.js';
import { state } from '../state.js';
import { toast } from '../ui.js';
import { FilterBar, loadCatalog } from '../filters.js';
import * as connect from './connect.js';

export async function render(root) {
  await connect.render(root);
  await loadCatalog(true);
  root.querySelector('h1').textContent = '设置';
  const description = root.querySelector('.page-head p');
  if (description) description.textContent = '连接配置、共享筛选预设与批量操作参数。';
  const page = root.querySelector('.page');
  const batch = state.config?.batch || {};
  page.insertAdjacentHTML('beforeend', `<section class="workspace-card preferences-section"><div class="card-head"><h3>共享筛选预设</h3><span class="tiny muted">可编辑并另存内置规则，也可更新或删除自定义预设</span></div><div class="card-body" id="preferences-filters"></div></section>
    <section class="workspace-card preferences-section"><div class="card-head"><h3>批量操作默认参数</h3></div><form class="card-body runtime-settings"><label>每条间隔（秒）<input class="input" id="preferences-interval" type="number" min="0.8" max="10" step="0.2" value="${Number(batch.interval) || 2}"/></label><label>失败重试次数<input class="input" id="preferences-retries" type="number" min="0" max="5" value="${Number(batch.retries) || 0}"/></label><label>试改条数<input class="input" id="preferences-trial" type="number" min="1" max="100" value="${Number(batch.trial_size) || 10}"/></label><button class="btn" type="submit">保存参数</button></form></section>`);
  new FilterBar(root.querySelector('#preferences-filters'));
  root.querySelector('.runtime-settings').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      state.config = await api.post('/api/config/preferences', { batch: { interval: root.querySelector('#preferences-interval').value,
        retries: root.querySelector('#preferences-retries').value, trial_size: root.querySelector('#preferences-trial').value } });
      toast('运行参数已保存', 'ok');
    } catch (error) { toast(error.message, 'err', error.hint); }
  });
}
