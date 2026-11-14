// 成员页：筛选、排序、分页、多选、导出

import * as api from '../api.js';
import { state, setMembers, replaceSelection, toggleSelection, clearSelection, groupDisplayName } from '../state.js';
import { navigate } from '../router.js';
import { toast, esc, fmtNumber, roleTag, emptyState, copyText } from '../ui.js';
import { openExportDialog } from '../export.js';

const query = { q: '', role: 'all', year: 'all', sort: 'join_time', desc: true, page: 1, size: 200 };

function minutes(ts) {
  return ts ? (Date.now() / 1000 - ts) / 86400 : Infinity;
}

function row(item, selected) {
  const silent = minutes(item.last_sent_ts) > 30;
  return `
    <tr data-qq="${esc(item.qq)}" class="${selected ? 'selected' : ''}">
      <td class="col-check">
        <label class="checkbox">
          <input type="checkbox" data-check="${esc(item.qq)}" ${selected ? 'checked' : ''} />
          <span></span>
        </label>
      </td>
      <td>
        <div class="name-cell">
          <span class="primary-name">${esc(item.display_name || '（无昵称）')}</span>
          <span class="secondary-name">${esc(item.nickname)}</span>
        </div>
      </td>
      <td class="mono num">${esc(item.qq)}</td>
      <td class="card-cell faint">${esc(item.card || '—')}</td>
      <td>${roleTag(item.role)}</td>
      <td class="mono num">${esc(item.level || '—')}</td>
      <td class="mono num">${esc(item.join_time || '—')}</td>
      <td class="mono num ${silent ? 'silent' : ''}">${esc(item.last_sent_time || '从未')}</td>
      <td class="col-actions">
        <button class="icon-btn" data-edit="${esc(item.qq)}" title="单独修改此人的名片" type="button">
          <svg viewBox="0 0 24 24"><path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16z"/></svg>
        </button>
      </td>
    </tr>`;
}

function tableHtml(data) {
  if (!data.items.length) {
    return emptyState(
      '没有匹配的成员',
      '调整关键词或筛选条件；如果刚加入新成员，点右上角刷新。'
    );
  }
  const rows = data.items.map((item) => row(item, state.selection.has(item.qq))).join('');
  return `
    <div class="table-wrap" style="max-height:calc(100vh - 320px)">
      <table class="table">
        <thead>
          <tr>
            <th class="col-check"><label class="checkbox"><input type="checkbox" id="check-all" /><span></span></label></th>
            <th class="sortable" data-sort="nickname">成员</th>
            <th>QQ 号</th>
            <th>群名片</th>
            <th class="sortable" data-sort="role">身份</th>
            <th>等级</th>
            <th class="sortable" data-sort="join_time">加群时间</th>
            <th class="sortable" data-sort="last_sent_time">最后发言</th>
            <th class="col-actions"></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

export async function render(root) {
  if (!state.group) {
    root.innerHTML = `
      <div class="page">
        <div class="card"><div class="card-body">
          ${emptyState('还没有选择群', '先到「群组」页选一个群，再回来管理成员。')}
          <div class="row" style="justify-content:center">
            <button class="btn btn-primary" id="goto-groups" type="button">去选择群</button>
          </div>
        </div></div>
      </div>`;
    root.querySelector('#goto-groups')?.addEventListener('click', () => navigate('groups'));
    return;
  }

  query.page = 1;
  const group = state.group;
  const canManage = ['owner', 'admin'].includes(group.my_role);
  const groupTitle = groupDisplayName(group) || group.group_name;
  const originName = groupTitle !== group.group_name ? `群名 ${esc(group.group_name)} · ` : '';

  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>${esc(groupTitle)}</h1>
          <p>${originName}群号 <span class="mono">${esc(group.group_id)}</span> · 已载入 <span id="all-total">${fmtNumber(group.member_count)}</span> 人
            <span id="fetched-at" class="faint"></span></p>
        </div>
        <div class="page-actions">
          <button class="btn" id="btn-export" type="button">导出</button>
          <button class="btn btn-primary ${canManage ? '' : 'is-disabled'}" id="btn-batch-card" type="button" ${canManage ? '' : 'disabled'}>批量改名片</button>
        </div>
      </div>

      <div class="card">
        <div class="card-body tight" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <input class="input" id="m-search" placeholder="搜索昵称 / 群名片 / QQ 号" style="width:230px" />
          <div class="seg" id="role-seg">
            <button data-role="all" class="active" type="button">全部</button>
            <button data-role="owner" type="button">群主</button>
            <button data-role="admin" type="button">管理员</button>
            <button data-role="member" type="button">成员</button>
          </div>
          <select class="select" id="year-select" style="width:130px"><option value="all">全部年份</option></select>
          <select class="select" id="size-select" style="width:110px">
            <option value="100">每页 100</option>
            <option value="200" selected>每页 200</option>
            <option value="500">每页 500</option>
          </select>
          <span class="spacer"></span>
          <span class="tiny faint" id="table-summary"></span>
        </div>
        <div id="member-body"><div class="skeleton" style="height:240px;margin:14px"></div></div>
        <div class="card-body tight" style="display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--line)">
          <span class="tiny faint" id="page-info"></span>
          <div class="pager" id="pager"></div>
        </div>
      </div>
    </div>

    <div class="action-bar" id="selection-bar">
      <span>已选 <span class="count" id="selected-count">0</span> 人</span>
      <span class="divider"></span>
      <button class="btn btn-sm" data-bar="copy" type="button">复制 QQ 号</button>
      <button class="btn btn-sm" data-bar="export" type="button">导出所选</button>
      <button class="btn btn-sm btn-primary" data-bar="cards" type="button">批量改名片</button>
      <button class="btn btn-sm btn-text" data-bar="clear" type="button">取消选择</button>
    </div>`;

  const body = root.querySelector('#member-body');
  const pager = root.querySelector('#pager');
  const pageInfo = root.querySelector('#page-info');
  const summary = root.querySelector('#table-summary');
  const yearSelect = root.querySelector('#year-select');
  const sizeSelect = root.querySelector('#size-select');
  const searchInput = root.querySelector('#m-search');
  const bar = root.querySelector('#selection-bar');

  const updateBar = () => {
    const count = state.selection.size;
    root.querySelector('#selected-count').textContent = count;
    bar.classList.toggle('show', count > 0);
  };

  const applySelection = (mutate) => {
    mutate();
    updateBar();
  };

  const bindTable = (data) => {
    const all = root.querySelector('#check-all');
    const pageQqs = data.items.map((item) => item.qq);
    const selectedOnPage = pageQqs.filter((qq) => state.selection.has(qq)).length;
    if (all) {
      all.checked = selectedOnPage > 0 && selectedOnPage === pageQqs.length;
      all.indeterminate = selectedOnPage > 0 && selectedOnPage < pageQqs.length;
      all.addEventListener('change', () => {
        applySelection(() => {
          pageQqs.forEach((qq) => {
            if (all.checked) state.selection.add(qq);
            else state.selection.delete(qq);
          });
        });
        body.innerHTML = tableHtml(data);
        bindTable(data);
      });
    }

    body.querySelectorAll('[data-check]').forEach((node) => {
      node.addEventListener('change', () => {
        applySelection(() => toggleSelection(node.dataset.check));
        node.closest('tr')?.classList.toggle('selected', node.checked);
        const current = root.querySelector('#check-all');
        const rest = root.querySelectorAll('[data-check]');
        const checked = root.querySelectorAll('[data-check]:checked');
        if (current) {
          current.checked = rest.length > 0 && checked.length === rest.length;
          current.indeterminate = checked.length > 0 && checked.length < rest.length;
        }
      });
    });

    body.querySelectorAll('[data-edit]').forEach((node) => {
      node.addEventListener('click', () => {
        replaceSelection([node.dataset.edit]);
        navigate('cards');
      });
    });

    root.querySelectorAll('.table th[data-sort]').forEach((th) => {
      const key = th.dataset.sort;
      th.classList.add('sortable');
      th.addEventListener('click', () => {
        if (query.sort === key) query.desc = !query.desc;
        else {
          query.sort = key;
          query.desc = true;
        }
        query.page = 1;
        load();
      });
    });
  };

  const renderPager = (data) => {
    pager.innerHTML = '';
    const totalPages = data.pages;
    const makeBtn = (label, page, disabled = false, active = false) => {
      const button = document.createElement('button');
      button.className = `btn btn-sm ${active ? 'btn-primary' : ''}`;
      button.textContent = label;
      button.disabled = disabled;
      button.addEventListener('click', () => {
        query.page = page;
        load();
      });
      return button;
    };
    pager.appendChild(makeBtn('‹', query.page - 1, query.page <= 1));
    const windowStart = Math.max(1, query.page - 2);
    const windowEnd = Math.min(totalPages, windowStart + 4);
    for (let page = windowStart; page <= windowEnd; page += 1) {
      pager.appendChild(makeBtn(String(page), page, false, page === query.page));
    }
    pager.appendChild(makeBtn('›', query.page + 1, query.page >= totalPages));
  };

  let lastData = null;
  let staleRetried = false;

  const paint = (data) => {
    lastData = data;
    body.innerHTML = tableHtml(data);
    bindTable(data);
    renderPager(data);
    pageInfo.textContent = `第 ${data.page} / ${data.pages} 页 · 筛选出 ${fmtNumber(data.total)} 人`;
    summary.textContent = `群主 ${data.counts.owner} · 管理员 ${data.counts.admin} · 成员 ${data.counts.member} · 空名片 ${data.counts.empty_card}`;
    root.querySelector('#all-total').textContent = fmtNumber(data.all_total);
    root.querySelector('#fetched-at').textContent = data.fetched_at
      ? `（数据时间 ${data.fetched_at}${data.stale ? ' · 正在后台更新' : ''}）`
      : '';
    if (data.self?.role) {
      const manage = ['owner', 'admin'].includes(data.self.role);
      const button = root.querySelector('#btn-batch-card');
      if (button) {
        button.disabled = !manage;
        button.classList.toggle('btn-primary', manage);
      }
    }
    const years = data.years || [];
    const current = yearSelect.value;
    yearSelect.innerHTML =
      '<option value="all">全部年份</option>' +
      years.map((year) => `<option value="${esc(year)}">${esc(year)} 年</option>`).join('');
    yearSelect.value = years.includes(current) ? current : 'all';
    query.year = yearSelect.value;
    updateBar();
  };

  async function load({ silent = false, fresh = false } = {}) {
    if (!silent) body.innerHTML = '<div class="skeleton" style="height:240px;margin:14px"></div>';
    try {
      const data = await api.get(`/api/groups/${encodeURIComponent(group.group_id)}/members`, {
        q: query.q,
        role: query.role,
        year: query.year,
        sort: query.sort,
        desc: query.desc ? 1 : 0,
        page: query.page,
        size: query.size,
        refresh: fresh ? 1 : '',
      });
      setMembers(data);
      paint(data);
      // 后端先给了旧缓存，后台正在刷新：稍等一会儿自动补一次最新数据
      if (data.stale && !staleRetried) {
        staleRetried = true;
        window.setTimeout(() => load({ silent: true }), 2500);
      }
      return data;
    } catch (error) {
      if (!lastData) {
        body.innerHTML = `
          <div style="padding:16px">
            <div class="hint-box danger">
              <span class="hint-icon">!</span>
              <div><strong>${esc(error.message)}</strong>${error.hint ? `<br><span class="faint">${esc(error.hint)}</span>` : ''}</div>
            </div>
          </div>`;
      } else {
        toast(error.message, 'err', error.hint);
      }
      return null;
    }
  }

  // ---------------------------------------------------------- 交互绑定
  let searchTimer = 0;
  searchInput.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      query.q = searchInput.value.trim();
      query.page = 1;
      load();
    }, 280);
  });

  root.querySelectorAll('#role-seg button').forEach((button) => {
    button.addEventListener('click', () => {
      root.querySelectorAll('#role-seg button').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      query.role = button.dataset.role;
      query.page = 1;
      load();
    });
  });

  yearSelect.addEventListener('change', () => {
    query.year = yearSelect.value;
    query.page = 1;
    load();
  });

  sizeSelect.addEventListener('change', () => {
    query.size = Number(sizeSelect.value);
    query.page = 1;
    load();
  });

  root.querySelector('#btn-batch-card').addEventListener('click', () => navigate('cards'));

  const doExport = (scope) => {
    const total = scope === 'selected' ? state.selection.size : lastData?.total ?? 0;
    openExportDialog({
      title: '导出群成员',
      scopeText: scope === 'selected' ? `已勾选的 ${total} 人` : `当前筛选结果 ${fmtNumber(total)} 人`,
      basePath: `/api/groups/${encodeURIComponent(group.group_id)}/export`,
      extraQuery: {
        scope,
        q: query.q,
        role: query.role,
        year: query.year,
        sort: query.sort,
        desc: query.desc ? 1 : 0,
        selected: scope === 'selected' ? [...state.selection].join(',') : '',
      },
    });
  };

  root.querySelector('#btn-export').addEventListener('click', () => doExport('filtered'));
  bar.querySelector('[data-bar="export"]').addEventListener('click', () => doExport('selected'));
  bar.querySelector('[data-bar="copy"]').addEventListener('click', async () => {
    const list = [...state.selection];
    if (!list.length) return;
    try {
      await copyText(list.join('\n'));
      toast(`已复制 ${list.length} 个 QQ 号`, 'ok', '每行一个，可直接粘到搜索框或表格');
    } catch (error) {
      toast(error.message, 'err', error.hint);
    }
  });
  bar.querySelector('[data-bar="cards"]').addEventListener('click', () => navigate('cards'));
  bar.querySelector('[data-bar="clear"]').addEventListener('click', () => {
    applySelection(() => clearSelection());
    load();
  });

  // 上一次拿到的名单还能用就先画出来，避免每次进页面都对着骨架屏
  const cachedPayload = state.members && state.members.group_id === group.group_id ? state.members : null;
  if (cachedPayload) {
    paint(cachedPayload);
    await load({ silent: true });
  } else {
    await load();
  }
}

export async function refresh() {
  const root = document.getElementById('view');
  if (!state.group) return;
  query.page = 1;
  const data = await api.get(`/api/groups/${encodeURIComponent(state.group.group_id)}/members`, {
    q: query.q,
    role: query.role,
    year: query.year,
    sort: query.sort,
    desc: query.desc ? 1 : 0,
    page: 1,
    size: query.size,
    refresh: 1,
  });
  setMembers(data);
  await render(root);
}
