import { state } from '../state.js';
import { esc, toast, fmtNumber } from '../ui.js';
import { FilterBar, emptyRule, clone } from '../filters.js';
import { chooseGroups, requestData, jobBanner, errorBox, exportData, showDetails, scopeContext, names, scopeCard } from '../workspace.js';
import { ResultTable, dataColumns } from '../result-table.js';
import { groupTag } from '../field-display.js';

export function mountComparison(container, cfg, save) {
  let data, list, ticket=0, loading=false, ready=false;
  const chosen=new Set();
  cfg.rule ||= emptyRule(); cfg.saved ||= []; cfg.status ||= 'missing';
  container.innerHTML=`<div class="member-comparison-task"><div class="task-heading"><div><h2>群关系核对</h2><p>来源群的成员合并成一份名单，分别核对每个目标群。仅查看和导出，不自动加人或移除成员。</p></div><button class="btn" id="compare-refresh">刷新名单</button></div>
    <div class="task-scope-grid" id="compare-scopes"></div>
    <section class="workspace-card comparison-roster-filter"><div class="card-head"><h3>名单成员条件</h3><span class="tiny muted">先筛选来源记录，再按 QQ号合并去重</span></div><div id="compare-filter" class="shared-filter"></div></section>
    <div class="comparison-config-bar"><select class="input" id="compare-saved" aria-label="已保存的核对配置"></select><button class="btn btn-sm" id="compare-save-toggle">保存核对配置</button><button class="btn btn-sm btn-text" id="compare-delete">删除已选配置</button><span id="compare-expected" class="tiny muted"></span><div id="compare-save-form" hidden><input class="input" id="compare-config-name" placeholder="配置名称" aria-label="核对配置名称"/><button class="btn btn-sm" id="compare-save">另存配置</button></div></div>
    <div class="comparison-layout"><aside id="compare-targets" class="comparison-targets" aria-label="逐群核对摘要"></aside><section class="workspace-card comparison-results"><div class="comparison-result-head"><h3 id="compare-active-name">选择待核对群</h3><span class="tiny muted" id="compare-selected"></span></div>
    <div class="workspace-search"><div class="view-tabs" id="compare-status"></div><input class="input" id="compare-search" aria-label="搜索核对名单" placeholder="搜索 QQ号、昵称或群昵称" value="${esc(cfg.search||'')}"/></div>
    <div class="workspace-toolbar"><span class="tiny muted">导出范围</span><select class="input operation-range" id="compare-range"><option value="filtered">当前群的全部筛选结果</option><option value="selected">仅勾选的记录</option></select><span class="spacer"></span><button class="btn btn-sm" id="compare-copy">复制名单</button><select class="input format-select" id="compare-format" aria-label="导出格式">${(state.config?.formats||['csv']).map(format=>`<option>${format}</option>`).join('')}</select><button class="btn btn-sm" id="compare-export">导出</button></div><div id="compare-progress" hidden></div><div id="compare-results"></div></section></div></div>`;
  const root=container.querySelector('.member-comparison-task');
  const host=root.querySelector('#compare-results');
  const progress=root.querySelector('#compare-progress');
  const selection=()=>{
    if(!root.isConnected)return;
    root.querySelector('#compare-selected').textContent=`已勾选 ${chosen.size} 人`;
    const disabled=loading||!ready||!data?.total||root.querySelector('#compare-range').value==='selected'&&!chosen.size;
    root.querySelector('#compare-copy').disabled=root.querySelector('#compare-export').disabled=disabled;
  };
  const clear=()=>{chosen.clear();root.querySelector('#compare-range').value='filtered';selection();};
  const paintSaved=()=>{root.querySelector('#compare-saved').innerHTML='<option value="">选择已保存的核对配置</option>'+cfg.saved.map(item=>`<option value="${esc(item.id)}" ${item.id===cfg.savedId?'selected':''}>${esc(item.name)}</option>`).join('');};
  const paintScopes=()=>{
    root.querySelector('#compare-scopes').innerHTML=scopeCard('1 · 名单来源群',cfg.sourceIds,'compare-pick-source','这些群中符合条件的人，合并后作为本次应到名单。')+scopeCard('2 · 待核对群',cfg.targetIds,'compare-pick-target','名单中的每个人，分别与这些群的实际成员核对。');
    root.querySelector('#compare-pick-source').addEventListener('click',()=>chooseGroups({title:'选择名单来源群',selected:cfg.sourceIds,onApply(ids){cfg.sourceIds=ids;clear();paintScopes();load();}}));
    root.querySelector('#compare-pick-target').addEventListener('click',()=>chooseGroups({title:'选择待核对群',selected:cfg.targetIds,onApply(ids){cfg.targetIds=ids;cfg.activeTarget=ids[0]||'';clear();paintScopes();load();}}));
  };
  const paintStatus=()=>{
    root.querySelector('#compare-status').innerHTML=[['missing','缺少'],['outside','名单外'],['common','共有'],['all','全部']].map(([id,label])=>`<button data-status="${id}" class="${cfg.status===id?'active':''}">${label}</button>`).join('');
    root.querySelectorAll('[data-status]').forEach(button=>button.addEventListener('click',()=>{cfg.status=button.dataset.status;clear();paintStatus();load();}));
  };
  const load=async(force=false)=>{
    const token=++ticket;loading=true;ready=false;save();selection();host.classList.add('is-loading');
    if(!cfg.sourceIds.length||!cfg.targetIds.length){
      list?.destroy();data=null;host.innerHTML='<div class="empty"><strong>先选名单来源群和待核对群</strong><p>例如：师生群作为来源，活动群作为待核对群。</p></div>';root.querySelector('#compare-targets').innerHTML='';loading=false;host.classList.remove('is-loading');selection();return;
    }
    if(!cfg.targetIds.includes(cfg.activeTarget))cfg.activeTarget=cfg.targetIds[0];
    try {
      const response=await requestData('/api/members/compare',{source_group_ids:cfg.sourceIds,target_group_ids:cfg.targetIds,source_filter:cfg.rule,target_group_id:cfg.activeTarget,status:cfg.status,search:cfg.search||'',show_remark:scopeContext([]).show_remark,refresh:force},job=>jobBanner(progress,job));
      if(!root.isConnected||token!==ticket)return;
      data=response;ready=true;list?.destroy();
      list=new ResultTable(host,{selected:chosen,sort:{field:'member.qq',desc:false},layoutKey:'comparison',onSelection:selection,onReload:()=>load(),onDetail:row=>showDetails({scope:scopeContext([...cfg.sourceIds,...cfg.targetIds])},row,row.detail_group_id)});
      list.setData(data,dataColumns(data,{selected:chosen}));
      root.querySelector('#compare-expected').textContent=`名单合并去重后 ${fmtNumber(data.expected)} 人`;
      root.querySelector('#compare-active-name').textContent=names([cfg.activeTarget])[0];
      root.querySelector('#compare-targets').innerHTML=data.summaries.map(group=>`<button class="comparison-target ${group.group_id===cfg.activeTarget?'active':''}" data-target="${esc(group.group_id)}"><strong>${groupTag(group.name,group.group_id)}</strong><span>应到 ${fmtNumber(group.expected)} · 群内 ${fmtNumber(group.actual)}</span><small>缺少 ${fmtNumber(group.missing)} · 名单外 ${fmtNumber(group.outside)} · 共有 ${fmtNumber(group.common)}</small></button>`).join('');
      root.querySelectorAll('[data-target]').forEach(button=>button.addEventListener('click',()=>{cfg.activeTarget=button.dataset.target;clear();load();}));
    }catch(error){ready=false;if(root.isConnected&&token===ticket){if(!data)host.innerHTML=errorBox(error);else toast('核对未完成，仍显示上次结果','err',error.message+' '+(error.hint||''));}}
    finally{if(token===ticket){loading=false;host.classList.remove('is-loading');selection();}}
  };
  const paintFilter=()=>new FilterBar(root.querySelector('#compare-filter'),{rule:cfg.rule,context:'comparison',onApply(rule){cfg.rule=rule;clear();load();}});
  root.querySelector('#compare-search').addEventListener('change',event=>{cfg.search=event.target.value.trim();clear();load();});
  root.querySelector('#compare-refresh').addEventListener('click',()=>{clear();load(true);});
  root.querySelector('#compare-range').addEventListener('change',selection);
  const exportSpec=()=>({query_id:data.query_id,selected:root.querySelector('#compare-range').value==='selected'?[...chosen]:undefined});
  root.querySelector('#compare-copy').addEventListener('click',()=>exportData(exportSpec(),'tsv',progress));
  root.querySelector('#compare-export').addEventListener('click',()=>exportData(exportSpec(),root.querySelector('#compare-format').value,progress));
  root.querySelector('#compare-save-toggle').addEventListener('click',()=>{const form=root.querySelector('#compare-save-form');form.hidden=!form.hidden;});
  root.querySelector('#compare-save').addEventListener('click',()=>{
    const name=root.querySelector('#compare-config-name').value.trim();
    if(!name){toast('请填写配置名称','warn');return;}
    const item={id:crypto.randomUUID(),name,sourceIds:[...cfg.sourceIds],targetIds:[...cfg.targetIds],rule:clone(cfg.rule)};
    cfg.saved.push(item);cfg.savedId=item.id;save();paintSaved();root.querySelector('#compare-save-form').hidden=true;toast('核对配置已保存到当前账号的浏览器','ok');
  });
  root.querySelector('#compare-saved').addEventListener('change',event=>{
    cfg.savedId=event.target.value;const item=cfg.saved.find(entry=>entry.id===cfg.savedId);if(!item)return;
    cfg.sourceIds=item.sourceIds.filter(id=>state.groups.some(group=>group.group_id===id));cfg.targetIds=item.targetIds.filter(id=>state.groups.some(group=>group.group_id===id));cfg.rule=clone(item.rule);cfg.status='missing';cfg.search='';root.querySelector('#compare-search').value='';cfg.activeTarget=cfg.targetIds[0];clear();paintScopes();paintFilter();paintStatus();load();
  });
  root.querySelector('#compare-delete').addEventListener('click',()=>{if(!cfg.savedId)return;cfg.saved=cfg.saved.filter(item=>item.id!==cfg.savedId);cfg.savedId='';save();paintSaved();toast('已删除核对配置','ok');});
  paintScopes();paintFilter();paintSaved();paintStatus();load();
  return {dispose(){ticket++;list?.destroy();},refresh:()=>{clear();return load(true);}};
}
