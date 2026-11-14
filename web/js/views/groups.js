// 群列表页：搜索 / 只看可管理 / 收藏 / 群备注 / 正则自动分组 / 多选导出 / 共同成员

import * as api from '../api.js';
import { state, setGroups, selectGroup, loadPrefs, savePrefs } from '../state.js';
import { navigate } from '../router.js';
import { toast, esc, emptyState, fmtNumber, openDrawer, copyText } from '../ui.js';
import { openExportDialog } from '../export.js';

const DEFAULT_REGEX = '^【(.+?)】';
const STAR_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.9.9-4.3 4.2 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z"/></svg>';

let keyword = '';
let hideUnmanaged = false;
let onlyFavorite = false;
let showRemark = true;
let autoGroup = true;
let groupRegex = DEFAULT_REGEX;
let favoriteIds = new Set();
let picked = new Set();
let pendingRemarksForce = false;

function isManaged(group) {
  return ['owner', 'admin'].includes(group.my_role);
}

/** 卡片上展示的群名：开了「显示群备注」且有备注时用备注 */
function displayName(group) {
  return (showRemark && group.group_remark) || group.group_name || group.group_id;
}

function roleTag(group) {
  if (group.my_role === 'owner') return '<span class="tag tag-owner">我是群主</span>';
  if (group.my_role === 'admin') return '<span class="tag tag-admin">我是管理员</span>';
  if (group.my_role === 'member') return '<span class="tag tag-member">我是成员</span>';
  return '<span class="tag tag-ghost">身份未知</span>';
}

function avatarHtml(group) {
  const gid = encodeURIComponent(group.group_id);
  const letter = esc((displayName(group) || '群').slice(0, 1));
  return `
    <div class="avatar avatar-lg">
      <span class="avatar-letter">${letter}</span>
      <img data-avatar="1" src="https://p.qlogo.cn/gh/${gid}/${gid}/140" alt=""
        loading="lazy" referrerpolicy="no-referrer" />
    </div>`;
}

function card(group) {
  const active = state.group?.group_id === group.group_id;
  const fav = favoriteIds.has(group.group_id);
  const pickedOn = picked.has(group.group_id);
  const id = esc(group.group_id);
  const name = displayName(group);
  const showOrigin = showRemark && group.group_remark && group.group_remark !== group.group_name;

  return `
    <div class="group-card ${active ? 'active' : ''} ${pickedOn ? 'picked' : ''}" data-gid="${id}" role="button" tabindex="0">
      <div class="gc-top">
        ${avatarHtml(group)}
        <div class="gc-main">
          <div class="gc-name" title="${esc(name)}">${esc(name)}</div>
          ${showOrigin ? `<div class="gc-sub" title="${esc(group.group_name)}">${esc(group.group_name)}</div>` : ''}
          <div class="gc-id">群号 ${id}</div>
        </div>
        <div class="gc-tools">
          <button class="icon-btn gc-star ${fav ? 'on' : ''}" data-fav="${id}" type="button"
            title="${fav ? '取消收藏' : '收藏这个群'}">${STAR_SVG}</button>
          <span class="checkbox checkbox-lg gc-pick" title="勾选后可批量导出 / 查共同成员">
            <input type="checkbox" data-pick="${id}" ${pickedOn ? 'checked' : ''} />
            <span></span>
          </span>
        </div>
      </div>
      <div class="gc-meta">
        <span class="tag">${fmtNumber(group.member_count)} 人</span>
        ${roleTag(group)}
        ${isManaged(group) ? '' : '<span class="tag tag-danger">无法管理</span>'}
      </div>
    </div>`;
}

function visibleGroups() {
  const text = keyword.trim().toLowerCase();
  const list = state.groups.filter((group) => {
    const fav = favoriteIds.has(group.group_id);
    if (onlyFavorite && !fav) return false;
    // 收藏的群就算管不了也保留，否则「收藏」会被过滤器吃掉
    if (hideUnmanaged && !isManaged(group) && !fav) return false;
    if (!text) return true;
    const haystack = `${group.group_name}${group.group_remark || ''}${group.group_id}`.toLowerCase();
    return haystack.includes(text);
  });

  return list.sort((a, b) => {
    const fa = favoriteIds.has(a.group_id) ? 0 : 1;
    const fb = favoriteIds.has(b.group_id) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return b.member_count - a.member_count;
  });
}

/** 按当前显示名 + 正则切分组；命中取第一个捕获组，未命中归到「未分组」 */
function buildSections(list) {
  if (!autoGroup) return [{ key: '', title: '', groups: list }];

  let regex = null;
  try {
    regex = new RegExp(groupRegex);
  } catch (error) {
    return [{ key: '', title: '', groups: list, invalid: true }];
  }

  const buckets = new Map();
  list.forEach((group) => {
    let key = '';
    const name = displayName(group);
    const matched = name.match(regex);
    if (matched) key = String(matched[1] ?? matched[0] ?? '').trim();
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(group);
  });

  const titles = [...buckets.keys()].filter((key) => key).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  if (buckets.has('')) titles.push('');

  return titles.map((key) => ({
    key,
    title: key || '未分组',
    groups: buckets.get(key),
  }));
}

function sectionHtml(section) {
  const managed = section.groups.filter(isManaged).length;
  const head =
    autoGroup && !section.invalid
      ? `<div class="group-section-head">
           <span class="gs-title">${esc(section.title)}</span>
          <span class="gs-count">${fmtNumber(section.groups.length)} 个群 · 可管理 ${fmtNumber(managed)}</span>
        </div>`
      : '';
  return `<section class="group-section">${head}<div class="group-grid">${section.groups.map(card).join('')}</div></section>`;
}

function commonRowsHtml(payload, rows) {
  return rows
    .map((row) => {
      const cells = payload.groups
        .map((group) => {
          const info = (row.groups || {})[group.group_id] || {};
          const sub = [info.role_label, info.join_time].filter(Boolean).join(' · ');
          return `
            <td>
              <div class="name-cell">
                <span class="primary-name">${esc(info.display_name || '—')}</span>
                <span class="secondary-name">${esc(sub || '—')}</span>
              </div>
            </td>`;
        })
        .join('');
      return `
        <tr>
          <td>
            <div class="name-cell">
              <span class="primary-name">${esc(row.nickname || '（无昵称）')}</span>
            </div>
          </td>
          <td class="mono num">${esc(row.qq)}</td>
          ${cells}
        </tr>`;
    })
    .join('');
}

function openCommon(groupIds) {
  const params = { groups: groupIds.join(',') };

  openDrawer({
    title: '共同群成员',
    body: '<div class="skeleton" style="height:200px"></div>',
    footer: `
      <button class="btn" data-close="1" type="button">关闭</button>
      <button class="btn" id="common-copy" type="button" disabled>复制到剪贴板</button>
      <button class="btn btn-primary" id="common-export" type="button" disabled>开始导出</button>`,
    onMount: (panel, foot) => {
      const copyBtn = foot.querySelector('#common-copy');
      const exportBtn = foot.querySelector('#common-export');

      let payload = null;
      let filter = '';

      const rowsShown = () => {
        if (!payload) return [];
        const text = filter.trim().toLowerCase();
        if (!text) return payload.items;
        return payload.items.filter((row) => {
          if (row.qq.includes(text)) return true;
          if ((row.nickname || '').toLowerCase().includes(text)) return true;
          return Object.values(row.groups || {}).some(
            (info) =>
              (info.display_name || '').toLowerCase().includes(text) ||
              (info.card || '').toLowerCase().includes(text)
          );
        });
      };

      const paintRows = () => {
        if (!payload) return;
        const rows = rowsShown();
        panel.querySelector('#common-rows').innerHTML = rows.length
          ? commonRowsHtml(payload, rows)
          : `<tr><td colspan="${payload.groups.length + 2}"><div class="empty"><strong>没有匹配的成员</strong><p>换个关键词试试。</p></div></td></tr>`;
        panel.querySelector('#common-summary').textContent =
          `${payload.groups.length} 个群 · 交集 ${fmtNumber(payload.total)} 人 · 当前显示 ${fmtNumber(rows.length)} 人` +
          (payload.truncated ? '（只展示前 5000 人）' : '');
      };

      const build = () => {
        const heads = payload.groups
          .map((group) => `<th title="群号 ${esc(group.group_id)}">${esc(group.group_name)}</th>`)
          .join('');
        panel.innerHTML = `
          <div class="row" style="gap:10px;flex-wrap:wrap">
            <input class="input" id="common-search" placeholder="搜索昵称 / 群名片 / QQ 号" style="width:230px" />
            <span class="spacer"></span>
            <span class="tiny faint" id="common-summary"></span>
          </div>
          <div class="table-wrap" style="max-height:calc(100vh - 280px)">
            <table class="table">
              <thead>
                <tr><th>成员</th><th>QQ 号</th>${heads}</tr>
              </thead>
              <tbody id="common-rows"></tbody>
            </table>
          </div>
          <div class="hint-box">
            <span class="hint-icon">i</span>
            <div>只列出同时在这 ${payload.groups.length} 个群里的成员。右侧按群展示群名片 / 身份 / 加群时间。</div>
          </div>`;

        panel.querySelector('#common-search').addEventListener('input', (event) => {
          filter = event.target.value;
          paintRows();
        });
        paintRows();
        copyBtn.disabled = false;
        exportBtn.disabled = false;
      };

      const runCopy = async () => {
        copyBtn.disabled = true;
        const original = copyBtn.textContent;
        copyBtn.textContent = '复制中…';
        try {
          const text = await api.getText('/api/export/common', { ...params, q: filter.trim(), format: 'tsv' });
          await copyText(text);
          const rows = Math.max(0, text.trim().split('\n').length - 1);
          toast(`已复制 ${rows} 行到剪贴板`, 'ok', '制表符分隔，可直接粘贴到 Excel / WPS');
        } catch (error) {
          toast(error.message || '复制失败', 'err', error.hint);
        } finally {
          copyBtn.disabled = false;
          copyBtn.textContent = original;
        }
      };

      copyBtn.addEventListener('click', runCopy);
      exportBtn.addEventListener('click', () => {
        api.download('/api/export/common', { ...params, q: filter.trim(), format: 'csv' });
        toast('已开始下载', 'ok');
      });

      api
        .get('/api/members/common', params)
        .then((data) => {
          payload = data;
          if (!payload.groups?.length) {
            panel.innerHTML = emptyState('没有可对比的群', '重新选群后再试。');
            return;
          }
          build();
        })
        .catch((error) => {
          panel.innerHTML = `
            <div class="hint-box danger">
              <span class="hint-icon">!</span>
              <div><strong>${esc(error.message)}</strong>${error.hint ? `<br><span class="faint">${esc(error.hint)}</span>` : ''}</div>
            </div>`;
        });
    },
  });
}

export async function render(root) {
  const prefs = loadPrefs();
  keyword = '';
  hideUnmanaged = Boolean(prefs.hideUnmanaged);
  onlyFavorite = false;
  showRemark = prefs.showRemark !== false;
  autoGroup = prefs.autoGroup !== false;
  groupRegex = typeof prefs.groupRegex === 'string' ? prefs.groupRegex : DEFAULT_REGEX;
  favoriteIds = new Set(Array.isArray(prefs.favoriteGroups) ? prefs.favoriteGroups : []);
  picked = new Set();

  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>群组</h1>
          <p>点卡片进入成员管理；勾选卡片右上角可批量导出或查共同成员。</p>
        </div>
        <div class="page-actions">
          <input class="input" id="group-search" placeholder="搜索群名 / 群备注 / 群号" style="width:210px" value="${esc(keyword)}" />
          <button class="btn" id="btn-reload" type="button">重新拉取</button>
        </div>
      </div>

      <div class="card">
        <div class="card-body tight" style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          <label class="check-inline" title="只显示我是群主 / 管理员的群">
            <span class="checkbox"><input type="checkbox" id="hide-unmanaged" ${hideUnmanaged ? 'checked' : ''} /><span></span></span>
            <span class="small muted">只看可管理</span>
          </label>
          <label class="check-inline" title="只显示已收藏的群">
            <span class="checkbox"><input type="checkbox" id="only-fav" ${onlyFavorite ? 'checked' : ''} /><span></span></span>
            <span class="small muted">只看收藏</span>
          </label>
          <span class="v-divider"></span>
          <label class="check-inline" title="有群备注的群，名称显示为群备注">
            <span class="checkbox"><input type="checkbox" id="show-remark" ${showRemark ? 'checked' : ''} /><span></span></span>
            <span class="small muted">显示群备注</span>
          </label>
          <label class="check-inline" title="按正则从群名里提取分组">
            <span class="checkbox"><input type="checkbox" id="auto-group" ${autoGroup ? 'checked' : ''} /><span></span></span>
            <span class="small muted">自动分组</span>
          </label>
          <input class="input mono" id="group-regex" style="width:168px;height:32px"
            placeholder="${esc(DEFAULT_REGEX)}" value="${esc(groupRegex)}"
            title="分组正则：取第一个捕获组作为分组名，未命中的群归入「未分组」"
            ${autoGroup ? '' : 'disabled'} />
          <span class="tiny text-danger" id="regex-state"></span>
          <span class="spacer"></span>
          <span class="tiny faint" id="group-summary"></span>
        </div>
      </div>

      <div id="group-body"><div class="skeleton" style="height:160px"></div></div>
    </div>

    <div class="action-bar" id="pick-bar">
      <span>已选 <span class="count" id="pick-count">0</span> 个群</span>
      <span class="divider"></span>
      <button class="btn btn-sm" data-bar="export" type="button">导出成员</button>
      <button class="btn btn-sm btn-primary" data-bar="common" type="button">共同成员</button>
      <button class="btn btn-sm btn-text" data-bar="clear" type="button">取消选择</button>
    </div>`;

  const container = root.querySelector('#group-body');
  const search = root.querySelector('#group-search');
  const hideBox = root.querySelector('#hide-unmanaged');
  const favBox = root.querySelector('#only-fav');
  const remarkBox = root.querySelector('#show-remark');
  const groupBox = root.querySelector('#auto-group');
  const regexInput = root.querySelector('#group-regex');
  const regexState = root.querySelector('#regex-state');
  const bar = root.querySelector('#pick-bar');

  const updateMeta = () => {
    const summary = root.querySelector('#group-summary');
    if (!summary) return;
    const managed = state.groups.filter(isManaged).length;
    summary.textContent = `共 ${fmtNumber(state.groups.length)} 个群 · 可管理 ${fmtNumber(managed)} 个 · 收藏 ${fmtNumber(favoriteIds.size)} 个`;
  };

  const updateBar = () => {
    root.querySelector('#pick-count').textContent = fmtNumber(picked.size);
    bar.classList.toggle('show', picked.size > 0);
  };

  const updateRegexHint = () => {
    let valid = true;
    if (autoGroup) {
      try {
        new RegExp(groupRegex);
      } catch (error) {
        valid = false;
      }
    }
    regexState.textContent = valid ? '' : '正则无效，已按全部显示';
    regexInput.classList.toggle('is-invalid', !valid);
  };

  const openGroup = (gid) => {
    const group = state.groups.find((item) => item.group_id === gid);
    if (!group) return;
    selectGroup(group);
    navigate('members');
  };

  const toggleFav = (gid) => {
    if (favoriteIds.has(gid)) favoriteIds.delete(gid);
    else favoriteIds.add(gid);
    savePrefs({ favoriteGroups: [...favoriteIds] });
    paint();
    updateMeta();
  };

  const setPicked = (gid, on) => {
    if (on) picked.add(gid);
    else picked.delete(gid);
    const node = container.querySelector(`.group-card[data-gid="${CSS.escape(gid)}"]`);
    node?.classList.toggle('picked', on);
    updateBar();
  };

  const bindCards = () => {
    container.querySelectorAll('[data-avatar]').forEach((img) => {
      const drop = () => img.remove();
      if (img.complete && img.naturalWidth === 0) drop();
      else img.addEventListener('error', drop);
    });

    container.querySelectorAll('[data-gid]').forEach((node) => {
      const gid = node.dataset.gid;
      node.addEventListener('click', (event) => {
        if (event.target.closest('[data-fav]')) {
          toggleFav(gid);
          return;
        }
        if (event.target.closest('.gc-pick')) return;
        openGroup(gid);
      });
      node.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openGroup(gid);
        }
      });
      node.querySelector('[data-pick]')?.addEventListener('change', (event) => {
        event.stopPropagation();
        setPicked(gid, event.target.checked);
      });
    });
  };

  function paint() {
    const list = visibleGroups();
    updateRegexHint();

    if (!list.length) {
      const filtered = keyword || hideUnmanaged || onlyFavorite;
      container.innerHTML = emptyState(
        filtered ? '当前筛选下没有群' : '还没有加入任何群',
        filtered
          ? '换个关键词，或取消「只看可管理 / 只看收藏」。'
          : '确认 NapCat 登录的账号已经加入群聊。'
      );
      return;
    }

    container.innerHTML = buildSections(list).map(sectionHtml).join('');
    bindCards();
  }

  // 备注懒加载：列表先出，备注回来了再重绘
  let remarksLoading = false;
  async function loadRemarks(force = false) {
    if (remarksLoading || !state.groups.length) return;
    remarksLoading = true;
    try {
      const data = await api.get('/api/groups/remarks', force ? { refresh: 1 } : undefined);
      if (!data?.remarks) return;
      let changed = false;
      state.groups.forEach((group) => {
        const remark = data.remarks[group.group_id] || '';
        if (remark !== (group.group_remark || '')) {
          group.group_remark = remark;
          changed = true;
        }
      });
      if (changed) {
        setGroups([...state.groups]);
        paint();
      }
    } catch (error) {
      /* 备注是锦上添花，失败不打扰 */
    } finally {
      remarksLoading = false;
    }
  }

  search.addEventListener('input', () => {
    keyword = search.value.trim();
    paint();
  });

  hideBox.addEventListener('change', () => {
    hideUnmanaged = hideBox.checked;
    savePrefs({ hideUnmanaged });
    paint();
  });

  favBox.addEventListener('change', () => {
    onlyFavorite = favBox.checked;
    paint();
  });

  remarkBox.addEventListener('change', () => {
    showRemark = remarkBox.checked;
    savePrefs({ showRemark });
    paint();
    if (showRemark) loadRemarks();
  });

  groupBox.addEventListener('change', () => {
    autoGroup = groupBox.checked;
    regexInput.disabled = !autoGroup;
    savePrefs({ autoGroup });
    paint();
  });

  let regexTimer = 0;
  regexInput.addEventListener('input', () => {
    window.clearTimeout(regexTimer);
    regexTimer = window.setTimeout(() => {
      groupRegex = regexInput.value;
      savePrefs({ groupRegex });
      paint();
    }, 300);
  });

  root.querySelector('#btn-reload').addEventListener('click', () => refresh());

  bar.querySelector('[data-bar="export"]').addEventListener('click', () => {
    if (!picked.size) return;
    openExportDialog({
      title: '导出群成员（多群合并）',
      scopeText: `已勾选的 ${picked.size} 个群，每行带群号 / 群名，可用 Excel 筛选`,
      basePath: '/api/export/groups',
      extraQuery: { groups: [...picked].join(',') },
    });
  });

  bar.querySelector('[data-bar="common"]').addEventListener('click', () => {
    if (picked.size < 2) {
      toast('至少勾选两个群', 'warn', '共同成员需要对比两个及以上群聊。');
      return;
    }
    openCommon([...picked]);
  });

  bar.querySelector('[data-bar="clear"]').addEventListener('click', () => {
    picked.clear();
    paint();
    updateBar();
  });

  updateMeta();
  updateBar();
  updateRegexHint();

  if (state.groups.length) {
    paint();
  }

  try {
    const data = await api.get('/api/groups');
    setGroups(data.groups);
    // 群列表可能变了，过滤掉已不存在的勾选
    const ids = new Set(data.groups.map((group) => group.group_id));
    picked.forEach((gid) => {
      if (!ids.has(gid)) picked.delete(gid);
    });
    paint();
    updateMeta();
    updateBar();
    loadRemarks(pendingRemarksForce);
    pendingRemarksForce = false;
  } catch (error) {
    if (!state.groups.length) {
      container.innerHTML = `
        <div class="card"><div class="card-body">
          <div class="hint-box danger">
            <span class="hint-icon">!</span>
            <div><strong>${esc(error.message)}</strong>${error.hint ? `<br><span class="faint">${esc(error.hint)}</span>` : ''}</div>
          </div>
          <div class="row" style="margin-top:12px">
            <button class="btn btn-primary btn-sm" id="goto-connect" type="button">去连接</button>
          </div>
        </div></div>`;
      container.querySelector('#goto-connect')?.addEventListener('click', () => navigate('connect'));
    } else {
      toast(error.message, 'err', error.hint);
    }
  }
}

export async function refresh() {
  const root = document.getElementById('view');
  try {
    const data = await api.get('/api/groups', { refresh: 1 });
    setGroups(data.groups);
    if (root) {
      pendingRemarksForce = true;
      await render(root);
      toast('群列表已更新', 'ok');
    }
  } catch (error) {
    toast(error.message, 'err', error.hint);
  }
}
