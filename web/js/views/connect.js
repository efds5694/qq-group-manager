// 连接页：配置地址与令牌，测试连接后展示能力集

import * as api from '../api.js';
import { state, setSession } from '../state.js';
import { navigate } from '../router.js';
import { toast, esc, openDrawer } from '../ui.js';

const NAPCAT_HINT = `
  <div class="hint-box">
    <span class="hint-icon">i</span>
    <div>
      <strong>NapCat 侧需要先开启 HTTP 服务</strong><br>
      打开 NapCat WebUI（默认 6099）→ 网络配置 → 新建「HTTP 服务器」→ 地址 127.0.0.1、端口 3000、设置一个令牌 → 保存并重启。
      如果 3000 被其它协议端占用，可改用 3002，并在上面同步填写。
    </div>
  </div>`;

function capabilityChips(caps) {
  const items = [
    ['群列表 / 成员', true],
    ['批量改群昵称', true],
    ['群公告', caps?.notice],
    ['群头像', caps?.portrait],
    ['加群方式', caps?.add_option],
    ['群搜索', caps?.search_option],
  ];
  return items
    .map(
      ([label, ok]) =>
        `<span class="chip ${ok ? '' : 'off'}">${ok ? '✓' : '×'} ${esc(label)}</span>`
    )
    .join('');
}

export async function render(root, { embedded = false } = {}) {
  const config = await api.get('/api/config');
  state.config = config;
  const active = config.active || {};
  const adapters = config.adapters || [];

  const profiles = (config.profiles || [])
    .map(
      (item) => `
      <button class="chip ${item.name === config.active_profile ? '' : 'off'}" data-profile="${esc(item.name)}" type="button">
        ${esc(item.name)} · ${esc(item.base_url.replace(/^https?:\/\//, ''))}
      </button>`
    )
    .join('');

  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>连接协议端</h1>
          <p>本工具只与你本机的 NapCat 通信，所有数据都留在本地。</p>
        </div>
        <div class="page-actions">
          <button class="btn" id="btn-guide" type="button">接入说明</button>
        </div>
      </div>

      <div class="split">
        <div class="card">
          <div class="card-head">
            <h3>连接设置</h3>
            <span class="sub">${esc(active.adapter || 'napcat')}</span>
          </div>
          <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
            <div class="field">
              <label for="f-name">配置名称</label>
              <input class="input" id="f-name" value="${esc(active.name || 'NapCat')}" placeholder="例如 NapCat 主号" />
              <span class="help">多个 QQ 号可以存成不同配置，随时切换。</span>
            </div>
            <div class="field">
              <label for="f-url">服务地址</label>
              <input class="input mono" id="f-url" value="${esc(active.base_url || 'http://127.0.0.1:3000')}" placeholder="http://127.0.0.1:3000" />
            </div>
            <div class="field">
              <label for="f-adapter">协议端类型</label>
              <select class="select" id="f-adapter">
                ${adapters
                  .map(
                    (item) =>
                      `<option value="${esc(item.value)}" ${item.value === active.adapter ? 'selected' : ''}>${esc(item.label)}</option>`
                  )
                  .join('')}
              </select>
              <span class="help">将来换协议端只改这里，业务功能不变。</span>
            </div>
            <div class="field">
              <label for="f-token">访问令牌</label>
              <input class="input mono" id="f-token" type="password" autocomplete="off"
                placeholder="${active.has_token ? '已保存，留空表示不修改' : '与 NapCat 里填写的 token 一致'}" />
            </div>

            <div class="row" style="gap:10px">
              <button class="btn btn-primary" id="btn-connect" type="button">保存并连接</button>
              <button class="btn" id="btn-test" type="button">仅测试</button>
            </div>

            ${profiles ? `<div class="field"><label>已保存的配置</label><div class="var-list">${profiles}</div></div>` : ''}
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:14px">
          <div class="card">
            <div class="card-head">
              <h3>连接状态</h3>
              <span class="sub" id="status-sub">等待测试</span>
            </div>
            <div class="card-body" id="status-body">
              <div class="empty" style="padding:28px 10px">
                <svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.8 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>
                <strong>还没有测试连接</strong>
                <p>点左侧「保存并连接」，成功后会显示登录账号与可用功能。</p>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>功能能力</h3><span class="sub">按协议端自动探测</span></div>
            <div class="card-body">
              <div class="var-list" id="cap-list">${capabilityChips(state.caps)}</div>
              <div class="hint-box" style="margin-top:12px">
                <span class="hint-icon">i</span>
                <div>群公告、群头像、加群方式属于协议端扩展接口。探测不到时会自动隐藏对应按钮，不影响导出与批量改名。</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  if (embedded) {
    const heading = root.querySelector('.page-head');
    heading.replaceChildren(root.querySelector('#btn-guide'));
    heading.className = 'connection-help';
    root.querySelector('.page').className = 'connection-panel';
  }

  const urlInput = root.querySelector('#f-url');
  const nameInput = root.querySelector('#f-name');
  const tokenInput = root.querySelector('#f-token');
  const adapterSelect = root.querySelector('#f-adapter');
  const statusBody = root.querySelector('#status-body');
  const statusSub = root.querySelector('#status-sub');
  const connectBtn = root.querySelector('#btn-connect');
  const testBtn = root.querySelector('#btn-test');

  root.querySelector('#btn-guide')?.addEventListener('click', () => {
    openDrawer({
      title: 'NapCat 接入说明',
      body: `
        <div class="section-title">第 1 步 · 确认协议端在跑</div>
        <p class="small muted">任务管理器里应有 QQ 与 NapCat 进程。NapCat 启动后 WebUI 默认在 <span class="mono">http://127.0.0.1:6099</span>。</p>
        <div class="section-title">第 2 步 · 开启 HTTP 服务</div>
        <p class="small muted">WebUI → 网络配置 → 新建 → HTTP 服务器：<span class="mono">127.0.0.1:3000</span>，设置令牌，保存并重启 NapCat。</p>
        <div class="section-title">第 3 步 · 回填令牌</div>
        <p class="small muted">把同一串令牌填进本页「访问令牌」，点「保存并连接」。</p>
        ${NAPCAT_HINT}
        <div class="hint-box warn">
          <span class="hint-icon">!</span>
          <div>不要把 HTTP 服务或 WebUI 暴露到公网。工具本身只监听 127.0.0.1。</div>
        </div>`,
      footer: '<button class="btn" data-close="1" type="button">知道了</button>',
    });
  });

  const collect = () => ({
    name: nameInput.value.trim() || 'NapCat',
    base_url: urlInput.value.trim(),
    token: tokenInput.value.trim(),
    adapter: adapterSelect.value,
  });

  const renderStatus = (session) => {
    const login = session.login || {};
    statusSub.textContent = `${session.adapter_label || session.adapter} · ${login.elapsed_ms || 0} ms`;
    statusBody.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px">
        <div class="brand-mark" style="width:44px;height:44px;border-radius:12px;font-size:16px">${esc((login.nickname || 'Q').slice(0, 1))}</div>
        <div style="min-width:0">
          <div class="strong" style="font-size:15px">${esc(login.nickname || '未知昵称')}</div>
          <div class="mono faint">${esc(login.user_id || '')}</div>
        </div>
        <span class="spacer"></span>
        <span class="tag tag-ok">已连接</span>
      </div>
      <div class="grid grid-3" style="margin-top:16px">
        <div class="stat"><span class="label">协议端</span><span class="value" style="font-size:14px">${esc(login.app_name || session.adapter_label || 'OneBot')}</span></div>
        <div class="stat"><span class="label">版　　本</span><span class="value" style="font-size:14px">${esc(login.version || '—')}</span></div>
        <div class="stat"><span class="label">群 数 量</span><span class="value">${Number(session.capabilities?.group_count || 0)}</span></div>
      </div>
      ${session.notes?.length ? `<div class="hint-box warn" style="margin-top:12px"><span class="hint-icon">!</span><div>${session.notes.map(esc).join('<br>')}</div></div>` : ''}
      <div class="row" style="margin-top:14px">
        <button class="btn btn-primary btn-sm" id="btn-goto-groups" type="button">去看群列表</button>
      </div>`;
    statusBody.querySelector('#btn-goto-groups')?.addEventListener('click', () => navigate('groups'));
    root.querySelector('#cap-list').innerHTML = capabilityChips(session.capabilities);
  };

  const doConnect = async (silent = false) => {
    const profile = collect();
    if (!profile.base_url) {
      toast('请先填写服务地址', 'warn');
      urlInput.focus();
      return;
    }
    connectBtn.disabled = true;
    testBtn.disabled = true;
    connectBtn.textContent = '连接中…';
    try {
      await api.post('/api/config/profile', { profile });
      const data = await api.post('/api/connect', {});
      setSession(data.session);
      state.config = data.config;
      renderStatus(data.session);
      if (!silent) toast('连接成功', 'ok', `${data.session.login.nickname}（${data.session.login.user_id}）`);
      tokenInput.value = '';
      tokenInput.placeholder = '已保存，留空表示不修改';
    } catch (error) {
      statusSub.textContent = '连接失败';
      statusBody.innerHTML = `
        <div class="hint-box danger">
          <span class="hint-icon">!</span>
          <div><strong>${esc(error.message)}</strong>${error.hint ? `<br><span class="faint">${esc(error.hint)}</span>` : ''}</div>
        </div>`;
      if (!silent) toast(error.message, 'err', error.hint);
      state.connected = false;
    } finally {
      connectBtn.disabled = false;
      testBtn.disabled = false;
      connectBtn.textContent = '保存并连接';
    }
  };

  connectBtn.addEventListener('click', () => doConnect(false));
  testBtn.addEventListener('click', async () => {
    const profile = collect();
    testBtn.disabled = true;
    testBtn.textContent = '测试中…';
    try {
      await api.post('/api/config/profile', { profile });
      const data = await api.post('/api/connect', {});
      setSession(data.session);
      renderStatus(data.session);
      toast('连接正常', 'ok');
    } catch (error) {
      toast(error.message, 'err', error.hint);
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = '仅测试';
    }
  });

  root.querySelectorAll('[data-profile]').forEach((node) => {
    node.addEventListener('click', () => {
      const name = node.dataset.profile;
      const profile = (state.config?.profiles || []).find((item) => item.name === name);
      if (!profile) return;
      nameInput.value = profile.name;
      urlInput.value = profile.base_url;
      adapterSelect.value = profile.adapter || 'napcat';
      tokenInput.value = '';
      tokenInput.placeholder = profile.has_token ? '已保存，留空表示不修改' : '与 NapCat 里填写的 token 一致';
      toast(`已载入配置「${name}」，点保存并连接生效`, 'info');
    });
  });

  if (state.connected && state.session) {
    renderStatus(state.session);
  }
}

export async function refresh() {
  const data = await api.post('/api/connect', {});
  setSession(data.session);
  await render(document.getElementById('view'));
}
