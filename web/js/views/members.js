import { state, loadPrefs, savePrefs } from '../state.js';
import { esc, fmtNumber, toast } from '../ui.js';
import { FilterBar, catalog, emptyRule, fieldSelectOptions, clone } from '../filters.js';
import { initialize, requestData, jobBanner, scopeContext, showDetails, showPersonDetails, chooseColumns,
  chooseGroups, exportData, collect, errorBox, defaultSources, names, scopeCard } from '../workspace.js';
import { openRename } from '../actions.js';
import { ResultTable, dataColumns } from '../result-table.js';
import { mountComparison } from './member-comparison.js';
import { groupTag } from '../field-display.js';

let controller;
const OVERVIEW_FIELDS = ['member.qq','member.nickname','person.group_count','person.group_names'];
const DETAIL_FIELDS = ['member.qq','member.nickname','group.display_name','member.card','member.role','member.level','member.join_time','member.last_sent_time','member.title'];


function migrate(old, available) {
  const valid = ids => (ids || []).filter(id => available.has(id));
  const groups = valid(old.groupIds || (state.group ? [state.group.group_id] : defaultSources()));
  const source = valid(old.sources ?? defaultSources());
  const sourceRule = JSON.stringify(old.rule || {}).match(/person\.(reference_card|source_group_id|source_conflict|nickname_difference)/);
  return { task: 'overview', overview: { groupIds: groups, view: 'people', rule: sourceRule ? emptyRule() : old.rule || emptyRule(),
      columns: OVERVIEW_FIELDS, detailColumns: old.columns || DETAIL_FIELDS, search: old.search || '', groupBy: old.groupBy || {} },
    comparison: { sourceIds: source, targetIds: groups.filter(id => !source.includes(id)), rule: emptyRule(), status: 'missing', saved: [] },
    rename: { sourceIds: source, targetIds: groups.filter(id => !source.includes(id)), rule: sourceRule ? old.rule : emptyRule(), method: 'sync', sourceField: 'member.card' } };
}

export async function render(container) {
  await initialize();
  const account = state.session?.login?.user_id || 'local';
  const key = `member-tasks.${account}`;
  const allPrefs = loadPrefs();
  const available = new Set(state.groups.map(group => group.group_id));
  const prefs = clone(allPrefs[key] || migrate(allPrefs[`workbench.${account}`] || {}, available));
  for (const cfg of [prefs.overview,prefs.comparison,prefs.rename]) {
    for (const prop of ['groupIds','sourceIds','targetIds']) if (cfg[prop]) cfg[prop] = cfg[prop].filter(id => available.has(id));
  }
  const incoming = state.workbenchGroups ?? state.crossGroupTargets;
  if (incoming) { prefs.overview.groupIds = incoming.filter(id => available.has(id)); prefs.task = 'overview'; }
  if (state.workbenchMode) {
    prefs.task = 'overview';
    prefs.overview.view = state.workbenchMode;
    if (incoming && state.workbenchMode === 'memberships') { prefs.overview.rule=emptyRule();prefs.overview.search='';prefs.overview.groupBy={}; }
  }
  if (state.pendingRename) { prefs.task = 'rename'; state.pendingRename = false; }
  state.workbenchGroups = state.crossGroupTargets = state.workbenchMode = null;
  const save = () => savePrefs({ [key]: prefs });
  container.innerHTML = `<div class="page members-workspace"><div class="page-head"><div><span class="eyebrow">MEMBER WORKSPACE</span><h1>成员工作台</h1><p>先选择要做的事，再配置这次使用的群聊。</p></div></div>
    <nav class="member-task-tabs" aria-label="成员管理任务"><button data-task="overview"><strong>人员总览</strong><span>查看所有人和各群资料</span></button><button data-task="comparison"><strong>群关系核对</strong><span>对照名单，检查缺少和名单外人员</span></button><button data-task="rename"><strong>改群昵称</strong><span>明确昵称来源与修改目标</span></button></nav><div id="member-task-body"></div></div>`;
  const root = container.querySelector('.members-workspace');
  const mount = () => {
    controller?.dispose();
    root.querySelectorAll('[data-task]').forEach(button => { button.classList.toggle('active', button.dataset.task === prefs.task); button.setAttribute('aria-current', button.dataset.task === prefs.task ? 'page' : 'false'); });
    const target = root.querySelector('#member-task-body');
    controller = prefs.task === 'comparison' ? mountComparison(target, prefs.comparison, save) : mountList(target, prefs[prefs.task], save, prefs.task === 'rename');
    save();
  };
  root.querySelectorAll('[data-task]').forEach(button => button.addEventListener('click', () => { prefs.task = button.dataset.task; mount(); }));
  mount();
}

function mountList(container, cfg, save, renameTask) {
  let data, list, ticket = 0, loading = false, ready = false;
  const selected = new Set();
  let range = 'filtered';
  cfg.view ||= 'people'; cfg.method ||= 'sync'; cfg.rule ||= emptyRule(); cfg.groupBy ||= {}; cfg.sort ||= { field:'member.qq',desc:false };
  const sync = () => renameTask && cfg.method === 'sync';
  const ids = () => renameTask ? cfg.targetIds : cfg.groupIds;
  const sources = () => sync() ? cfg.sourceIds : [];
  const entity = () => !renameTask && cfg.view !== 'memberships' ? 'people' : 'memberships';
  const fields = () => renameTask ? sync() ? cfg.syncColumns || ['member.qq','member.nickname','person.reference_text','person.source_group_name','member.card','person.source_conflict','group.display_name'] : cfg.otherColumns || DETAIL_FIELDS
    : cfg.view === 'memberships' ? cfg.detailColumns || DETAIL_FIELDS : cfg.columns || OVERVIEW_FIELDS;
  const spec = (useRange = false) => {
    const quickRules = { different:{field:'person.nickname_difference',op:'eq',value:true}, conflict:{field:'person.source_conflict',op:'eq',value:true}, empty:{field:'person.reference_text',op:'empty'} };
    const quick = sync() && quickRules[cfg.quick];
    return { entity:entity(), scope:scopeContext(ids(),sources()), filter:quick ? { op:'and',rules:[cfg.rule,quick] } : cfg.rule,
      fields:fields(), search:cfg.search || '', sort:cfg.sort, group_by:cfg.groupBy, matrix:!renameTask && cfg.view==='matrix', matrix_field:cfg.matrixField || 'member.card',
      source_field:cfg.sourceField || 'member.card', selected:useRange && range==='selected' ? [...selected] : undefined };
  };
  container.innerHTML = `<div class="member-list-task"><div class="task-heading"><div><h2>${renameTask?'改群昵称':'人员总览'}</h2><p>${renameTask?'先选读取来源和修改目标，再预演逐条差异。':'默认每个 QQ 一行；同一个人在多个群中也能一次看清。'}</p></div><div class="row"><button class="btn" id="task-refresh">刷新名单</button>${renameTask?'<button class="btn btn-primary" id="task-rename">预演并改名</button>':''}</div></div>
    ${renameTask?`<div class="rename-method-bar"><label>生成方式 <select class="input" id="task-method"><option value="sync">从来源群同步</option><option value="template">按变量模板</option><option value="mapping">按 CSV 名单</option></select></label><label id="task-source-field-label">读取字段 <select class="input" id="task-source-field">${fieldSelectOptions(cfg.sourceField || 'member.card')}</select></label></div><div class="task-scope-grid" id="task-scopes"></div><div class="task-nickname-quick" id="task-quick"></div>`:'<div id="task-scopes"></div>'}
    <section class="workspace-card"><div class="workspace-search">${renameTask?'':`<select class="input task-display-mode" id="task-view" aria-label="人员显示方式"><option value="people">按人汇总</option><option value="memberships">群内明细</option><option value="matrix">逐群对照</option></select>`}<input class="input" id="task-search" aria-label="搜索成员" placeholder="搜索 QQ号、昵称、群昵称或群名" value="${esc(cfg.search || '')}"/><span class="workspace-total" id="task-total">读取中</span></div><div id="task-filter" class="shared-filter"></div>
    <div class="workspace-toolbar"><select class="input operation-range" id="task-range" aria-label="操作范围"><option value="filtered">全部筛选结果</option><option value="selected">仅勾选的记录</option></select><span class="tiny muted" id="task-selection"></span><button class="btn btn-sm btn-text" id="task-clear">取消勾选</button><span class="spacer"></span><label class="matrix-field-label" id="task-matrix-label" hidden>单元格 <select class="input" id="task-matrix">${catalog.fields.filter(field=>field.id.startsWith('member.')).map(field=>`<option value="${esc(field.id)}">${esc(field.label)}</option>`).join('')}</select></label><button class="btn btn-sm" id="task-columns">字段</button>
    <details class="display-options"><summary class="btn btn-sm">分组</summary><div><label>分组字段<select class="input" id="task-group-field"><option value="">不分组</option>${fieldSelectOptions(cfg.groupBy.field)}</select></label><label>提取分组的正则<input class="input" id="task-group-pattern" value="${esc(cfg.groupBy.pattern || '')}" placeholder="可选"/></label><button class="btn btn-sm" id="task-group-apply">应用分组</button></div></details><button class="btn btn-sm" id="task-copy">复制表格</button><select class="input format-select" id="task-format" aria-label="导出格式">${(state.config?.formats || ['csv']).map(format=>`<option>${format}</option>`).join('')}</select><button class="btn btn-sm" id="task-export">导出</button></div>
    <div id="task-progress" hidden></div><div id="task-results"></div></section><div class="workspace-secondary-actions"><button class="btn btn-sm btn-text" id="task-collect">补全本次范围资料</button><button class="btn btn-sm btn-text" id="task-retry">重试采集失败项</button><span class="tiny faint">滚动条对应全部结果，可直接拖到中间或末尾。</span></div></div>`;
  const root = container.querySelector('.member-list-task');
  const host = root.querySelector('#task-results');
  const progress = root.querySelector('#task-progress');
  const selection = () => {
    if (!root.isConnected) return;
    root.querySelector('#task-selection').textContent = `已勾选 ${selected.size} ${entity()==='people'?'人':'条记录'}`;
    root.querySelector('#task-clear').disabled = !selected.size;
    const disabled = loading || !ready || !data?.total || range==='selected' && !selected.size;
    for (const id of ['task-copy','task-export','task-rename']) { const button = root.querySelector(`#${id}`); if (button) button.disabled=disabled; }
  };
  const clear = () => { selected.clear(); range='filtered'; root.querySelector('#task-range').value=range; selection(); list?.schedule(); };
  const paintScopes = () => {
    root.querySelector('#task-scopes').innerHTML = renameTask
      ? `${sync()?scopeCard('1 · 读取昵称的来源群',cfg.sourceIds,'task-pick-source','只读取，不修改；从上到下采用第一个非空值。'):''}${scopeCard(sync()?'2 · 准备修改的目标群':'准备修改的目标群',cfg.targetIds,'task-pick-target','只对这些群中符合条件的成员生成改名计划。')}`
      : scopeCard('查看哪些群的成员',cfg.groupIds,'task-pick-target','所在群数和群关系仅统计本次查看范围。');
    root.querySelector('#task-pick-target').addEventListener('click',()=>chooseGroups({title:renameTask?'选择准备修改的目标群':'选择查看范围',selected:ids(),excluded:sources(),onApply(value){if(renameTask)cfg.targetIds=value;else cfg.groupIds=value;clear();paintScopes();load();}}));
    if (sync()) {
      root.querySelector('#task-source-field-label').hidden=false;
      root.querySelector('.task-scope-card').insertAdjacentHTML('beforeend',`<details class="priority-editor"><summary>调整来源优先级</summary>${cfg.sourceIds.map((gid,index)=>`<div class="source-order-row"><span>${index+1}</span><strong>${groupTag(names([gid])[0],gid)}</strong><button class="icon-btn" data-move-source="${index}" data-step="-1" ${index?'':'disabled'} aria-label="提高优先级">↑</button><button class="icon-btn" data-move-source="${index}" data-step="1" ${index<cfg.sourceIds.length-1?'':'disabled'} aria-label="降低优先级">↓</button></div>`).join('')}<button class="btn btn-sm btn-text" id="task-default-source">默认【师生】群</button></details>`);
      root.querySelectorAll('[data-move-source]').forEach(button=>button.addEventListener('click',()=>{const i=Number(button.dataset.moveSource),j=i+Number(button.dataset.step);[cfg.sourceIds[i],cfg.sourceIds[j]]=[cfg.sourceIds[j],cfg.sourceIds[i]];clear();paintScopes();load();}));
      const setSource=value=>{cfg.sourceIds=value;cfg.targetIds=cfg.targetIds.filter(id=>!value.includes(id));clear();paintScopes();load();};
      root.querySelector('#task-pick-source').addEventListener('click',()=>chooseGroups({title:'选择读取昵称的来源群',selected:cfg.sourceIds,onApply:setSource}));
      root.querySelector('#task-default-source').addEventListener('click',()=>setSource(defaultSources()));
    } else if(renameTask) root.querySelector('#task-source-field-label').hidden=true;
    if(renameTask) {
      const quick = root.querySelector('#task-quick'); quick.hidden=!sync();
      quick.innerHTML = [['all','全部'],['different','昵称不同'],['empty','无来源文本'],['conflict','来源冲突']].map(([id,label])=>`<button class="btn btn-sm ${cfg.quick===id||!cfg.quick&&id==='all'?'btn-primary':''}" data-quick="${id}">${label}</button>`).join('');
      quick.querySelectorAll('[data-quick]').forEach(button=>button.addEventListener('click',()=>{cfg.quick=button.dataset.quick;clear();paintScopes();load();}));
    }
  };
  const load = async (force=false) => {
    const token=++ticket;loading=true;ready=false;selection();save();host.classList.add('is-loading');
    root.querySelector('#task-matrix-label').hidden=renameTask||cfg.view!=='matrix';
    root.querySelector('#task-columns').hidden=!renameTask&&cfg.view==='matrix';
    if(!ids().length || sync()&&!sources().length) {
      list?.destroy();data=null;host.innerHTML=`<div class="empty"><strong>${sync()&&!sources().length?'选择读取昵称的来源群':'选择需要查看或修改的群'}</strong><p>上方分别选择这次使用的群聊。</p></div>`;
      root.querySelector('#task-total').textContent='尚未设置范围'; loading=false;host.classList.remove('is-loading');selection();return;
    }
    try {
      const response=await requestData('/api/query/start',{...spec(),refresh:force},job=>jobBanner(progress,job));
      if(!root.isConnected||token!==ticket)return;
      data=response;ready=true;list?.destroy();
      list=new ResultTable(host,{selected,sort:cfg.sort,layoutKey:renameTask?`rename:${sync()?'sync':'other'}`:`members:${cfg.view}`,onSelection:()=>{if(selected.size){range='selected';root.querySelector('#task-range').value=range;}selection();},
        onReload:()=>load(),onSort:field=>{cfg.sort={field,desc:cfg.sort.field===field?!cfg.sort.desc:false};clear();load();},
        onDetail:(row,gid)=>entity()==='people'?showPersonDetails(spec(),row,gid):showDetails(spec(),row,gid)});
      list.setData(data,dataColumns(data,{selected,matrix:!renameTask&&cfg.view==='matrix',matrixField:cfg.matrixField||'member.card',overview:!renameTask&&cfg.view==='people'}));
      root.querySelector('#task-total').textContent=`${fmtNumber(data.people)} 人 · ${fmtNumber(data.memberships)} 条群记录`;
    } catch(error) {ready=false;if(root.isConnected&&token===ticket){if(!data)host.innerHTML=errorBox(error);else toast('查询未完成，仍显示上次结果','err',error.message+' '+(error.hint||''));}}
    finally {if(token===ticket){loading=false;host.classList.remove('is-loading');selection();}}
  };
  new FilterBar(root.querySelector('#task-filter'),{rule:cfg.rule,context:renameTask?'rename':'overview',onApply(rule){cfg.rule=rule;clear();load();}});
  root.querySelector('#task-search').addEventListener('change',event=>{cfg.search=event.target.value.trim();clear();load();});
  root.querySelector('#task-range').addEventListener('change',event=>{range=event.target.value;selection();});
  root.querySelector('#task-clear').addEventListener('click',clear);
  root.querySelector('#task-refresh').addEventListener('click',()=>{clear();load(true);});
  root.querySelector('#task-columns').addEventListener('click',()=>chooseColumns(fields(),value=>{if(renameTask){if(sync())cfg.syncColumns=value;else cfg.otherColumns=value;}else if(cfg.view==='memberships')cfg.detailColumns=value;else cfg.columns=value;clear();load();},entity()));
  root.querySelector('#task-group-field').value=cfg.groupBy.field||'';
  root.querySelector('#task-group-apply').addEventListener('click',()=>{cfg.groupBy={field:root.querySelector('#task-group-field').value,pattern:root.querySelector('#task-group-pattern').value};root.querySelector('.display-options').open=false;clear();load();});
  root.querySelector('#task-matrix').value=cfg.matrixField||'member.card';
  root.querySelector('#task-matrix').addEventListener('change',event=>{cfg.matrixField=event.target.value;clear();load();});
  root.querySelector('#task-copy').addEventListener('click',()=>exportData({query_id:data.query_id,selected:range==='selected'?[...selected]:undefined},'tsv',progress));
  root.querySelector('#task-export').addEventListener('click',()=>exportData({query_id:data.query_id,selected:range==='selected'?[...selected]:undefined},root.querySelector('#task-format').value,progress));
  root.querySelector('#task-collect').addEventListener('click',()=>collect([...new Set([...ids(),...sources()])],progress,false,()=>load()));
  root.querySelector('#task-retry').addEventListener('click',()=>collect([...new Set([...ids(),...sources()])],progress,true,()=>load()));
  if(renameTask) {
    root.querySelector('#task-method').value=cfg.method;
    root.querySelector('#task-source-field').value=cfg.sourceField||'member.card';
    root.querySelector('#task-method').addEventListener('change',event=>{cfg.method=event.target.value;if(sync())cfg.targetIds=cfg.targetIds.filter(id=>!cfg.sourceIds.includes(id));clear();paintScopes();load();});
    root.querySelector('#task-source-field').addEventListener('change',event=>{cfg.sourceField=event.target.value;clear();load();});
    root.querySelector('#task-rename').addEventListener('click',()=>openRename(spec(true),progress,()=>{clear();load(true);},{method:cfg.method,source_field:cfg.sourceField}));
  } else {
    root.querySelector('#task-view').value=cfg.view;
    root.querySelector('#task-view').addEventListener('change',event=>{cfg.view=event.target.value;clear();load();});
  }
  paintScopes();load();
  return {dispose(){ticket++;list?.destroy();},refresh:()=>{clear();return load(true);}};
}

export async function refresh() { await controller?.refresh(); }
