import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ResultWindows } from '../web/js/result-windows.js';
import { Virtualizer } from '../web/vendor/tanstack-virtual-core/index.js';

test('vendored production virtualizer runs without Node.js globals',()=>{
  const url = new URL('../web/vendor/tanstack-virtual-core/index.js',import.meta.url).href;
  const run=spawnSync(process.execPath,['--input-type=module','-e',`delete globalThis.process; const {Virtualizer}=await import(${JSON.stringify(url)}); new Virtualizer({count:1,getScrollElement:()=>null,estimateSize:()=>56}).getVirtualItems();`],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
});

test('window cache jumps directly to the requested range and deduplicates requests', async () => {
  const calls=[];
  let finish;
  const cache=new ResultWindows({query_id:'original',total_rows:50000,offset:0,items:[{id:'first',kind:'record'}]},async (id,offset,limit)=>{
    calls.push({id,offset,limit});
    await new Promise(resolve=>{finish=resolve;});
    return {offset,items:Array.from({length:limit},(_,i)=>({id:String(offset+i),kind:'record'}))};
  });
  const first=cache.request(49999),duplicate=cache.request(49801);
  assert.deepEqual(calls,[{id:'original',offset:49800,limit:200}]);
  finish();await Promise.all([first,duplicate]);
  assert.equal(cache.get(49999).id,'49999');
  assert.equal(cache.get(0).id,'first');
  assert.equal(cache.get(200),undefined);
  await cache.request(49999);assert.equal(calls.length,1);
  const selected=new Set(['first','49999']);
  assert.equal(selected.has(cache.get(0).id),true);
  assert.equal(selected.has(cache.get(49999).id),true);
});

test('failed windows retain loaded rows and allow explicit retry; expiry stops requests', async()=>{
  let attempts=0;
  const cache=new ResultWindows({query_id:'q',total_rows:500,offset:0,items:[{id:'kept'}]},async()=>{
    if(++attempts===1)throw new Error('读取失败');
    throw Object.assign(new Error('已失效'),{code:'QUERY_EXPIRED'});
  });
  await cache.request(400);await cache.request(400);
  assert.equal(attempts,1);assert.equal(cache.get(0).id,'kept');
  cache.errors.clear();await cache.request(400);
  assert.equal(cache.expired,true);await cache.request(200);assert.equal(attempts,2);
});

test('a new query has an independent cache even when an old window returns late', async()=>{
  let finish;
  const old=new ResultWindows({query_id:'old',total_rows:1000,items:[]},()=>new Promise(resolve=>{finish=resolve;}));
  const pending=old.request(800);
  const current=new ResultWindows({query_id:'new',total_rows:1,items:[{id:'new-row'}]},()=>assert.fail('unexpected request'));
  finish({offset:800,items:[{id:'old-row'}]});await pending;
  assert.equal(current.get(0).id,'new-row');assert.equal(current.get(800),undefined);
});

test('virtual rows and columns remain bounded at the end of a long result',()=>{
  const rows=new Virtualizer({count:50000,getScrollElement:()=>null,estimateSize:()=>56,initialRect:{width:1000,height:500},initialOffset:50000*56-500,paddingStart:44,overscan:8});
  assert.equal(rows.getTotalSize(),50000*56+44);
  assert.ok(rows.getVirtualItems().length<30);
  assert.equal(rows.getVirtualItems().at(-1).index,49999);
  const columns=new Virtualizer({count:100,horizontal:true,getScrollElement:()=>null,estimateSize:()=>230,initialRect:{width:1000,height:500},initialOffset:230*90,paddingStart:350,overscan:2});
  assert.ok(columns.getVirtualItems().length<12);
  assert.ok(columns.getVirtualItems()[0].index>80);
});

// 筛选组件的状态单元测试，不启动浏览器或连接协议端。
globalThis.document = { getElementById: () => null, addEventListener() {} };
const { FilterBar, catalog } = await import('../web/js/filters.js');
const { restoreColumns, columnWidth, sortState } = await import('../web/js/column-layout.js');
const { groupTone, groupTag, renderField, detailSections } = await import('../web/js/field-display.js');
const { ResultTable, readResultIds } = await import('../web/js/result-table.js');
const { loadPrefs, savePrefs, state } = await import('../web/js/state.js');
const { assignGroupColors, groupColorStyle } = await import('../web/js/group-colors.js');
const { dataTimeLabel } = await import('../web/js/ui.js');
const api = await import('../web/js/api.js');
const { requestData, groupSelection, ResultQuery } = await import('../web/js/workspace.js');
const { mountSearch, matchesGroup } = await import('../web/js/search-controls.js');
const { operationRange, resolveOperationIds } = await import('../web/js/result-controls.js');
const { currentRoute, routeParams } = await import('../web/js/router.js');
catalog.presets = [{ id: 'builtin-owner', name: '群主', builtin: true }];
catalog.group_presets = [{ id: 'builtin-owner', name: '我是群主的群', builtin: true }];

test('preset options follow the current view and edited presets display as temporary', () => {
  const select = { value: 'builtin-owner' };
  const bar = Object.assign(Object.create(FilterBar.prototype), {
    entity: 'groups', selectedPreset: 'builtin-owner', temporary: false,
    element: { querySelector: () => select },
  });
  assert.match(bar.options(), /value="builtin-owner" selected>我是群主的群/);
  bar.markTemporary();
  assert.equal(select.value, '');
  assert.match(bar.options(), /value="" selected>临时筛选/);
  assert.doesNotMatch(bar.options(), /value="builtin-owner" selected/);
  // 保留原预设身份，仍可另存或更新原自定义规则。
  assert.equal(bar.selectedPreset, 'builtin-owner');
  bar.entity = 'memberships';
  assert.match(bar.options(), />群主<\/option>/);
  assert.doesNotMatch(bar.options(), /我是群主的群/);
});

test('column layouts restore valid widths while keeping selection and action columns fixed', () => {
  const columns = [{key:'__check',width:40},{key:'member.qq',width:130,pinned:true},{key:'member.nickname',width:180},{key:'__detail',width:85}];
  const restored = restoreColumns(columns, {'__check':200,'member.qq':235.6,'member.nickname':NaN,'__detail':400});
  assert.deepEqual(restored.map(column=>column.width),[40,236,180,85]);
  assert.equal(columnWidth(restored[1],20),90);
  assert.equal(columnWidth(restored[1],5000),1000);
  assert.equal(columnWidth(restored[1],'300'),130);
  assert.equal(restored[1].defaultWidth,130);
  assert.deepEqual(columns.map(column=>column.width),[40,130,180,85]);
});

test('resizing updates virtual offsets, preserves the current rows and selection, and persists only its layout', () => {
  const storage = new Map();
  globalThis.localStorage = {getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)};
  savePrefs({'table-columns.1.directory':{'member.nickname':220},'table-columns.2.directory':{'member.qq':400},favoriteGroups:['10']});
  const horizontal = new Virtualizer({count:0,horizontal:true,getScrollElement:()=>null,estimateSize:()=>180,initialRect:{width:1000,height:500}});
  const table=Object.assign(Object.create(ResultTable.prototype),{
    widthKey:'table-columns.1.directory',widths:{},horizontal,options:{selected:new Set(['10:1'])},
    viewport:{scrollTop:5600,scrollLeft:0},cache:{queryId:'same-query'},schedule(){},
    columns:restoreColumns([{key:'__check',width:40,pinned:true},{key:'member.qq',width:130,pinned:true},{key:'member.nickname',width:180},{key:'member.card',width:200}],{}),
  });
  table.reflowColumns();assert.equal(horizontal.getTotalSize(),550);
  table.setColumnWidth('member.qq',250);table.persistColumn('member.qq');
  assert.equal(table.pinnedWidth,290);
  assert.equal(horizontal.getVirtualItems()[0].start,290);
  assert.equal(horizontal.getTotalSize(),670);
  assert.equal(table.viewport.scrollTop,5600);
  assert.equal(table.cache.queryId,'same-query');
  assert.deepEqual([...table.options.selected],['10:1']);
  assert.deepEqual(loadPrefs()['table-columns.1.directory'],{'member.nickname':220,'member.qq':250});
  assert.deepEqual(loadPrefs()['table-columns.2.directory'],{'member.qq':400});
  assert.deepEqual(loadPrefs().favoriteGroups,['10']);
  table.setColumnWidth('member.nickname',315);table.persistColumn('member.nickname');
  assert.equal(horizontal.getVirtualItems()[1].start,605);
  table.resetColumn('member.qq');assert.equal(table.columns[1].width,130);
  assert.equal(loadPrefs()['table-columns.1.directory']['member.qq'],130);
  delete globalThis.localStorage;
});

test('header sort state distinguishes the active direction and unsorted columns',()=>{
  assert.deepEqual(sortState('member.qq',{field:'member.qq',desc:false}),{active:true,aria:'ascending',arrow:'↑',label:'升序'});
  assert.deepEqual(sortState('group.display_name',{field:'group.display_name',desc:true}),{active:true,aria:'descending',arrow:'↓',label:'降序'});
  assert.deepEqual(sortState('member.qq',{field:'member.nickname',desc:false}),{active:false,aria:'none',arrow:'',label:''});
});

test('group colors follow identity, escape labels, and statuses do not mistake a nickname for collection state',()=>{
  const tone=groupTone('675085435');
  assert.match(groupTag('原群名','675085435'),new RegExp(`group-tone-${tone}`));
  assert.match(groupTag('新群备注','675085435'),new RegExp(`group-tone-${tone}`));
  assert.ok(tone>=0);
  assert.doesNotMatch(groupTag('<script>"','675085435'),/<script>/);
  assert.match(renderField({values:{},display:{'member.age':'采集失败'}},'member.age'),/field-state-danger/);
  assert.doesNotMatch(renderField({values:{'member.nickname':'采集失败'},display:{'member.nickname':'采集失败'}},'member.nickname'),/field-state-danger/);
  assert.match(renderField({values:{'comparison.status':'missing','member.card':''},display:{}},'member.card'),/未加入/);
  assert.match(renderField({values:{'member.muted':true},display:{'member.muted':'是'}},'member.muted'),/field-state-warning/);
  assert.match(renderField({values:{'comparison.source_groups':['改名后的群']},display:{},source_group_ids:['675085435']},'comparison.source_groups'),new RegExp(`group-tone-${tone}`));
});

function selectionTable(ids, chosen = [], complete = false) {
  return Object.assign(Object.create(ResultTable.prototype), {
    data:{query_id:'q',total:ids.length}, options:{selected:new Set(chosen),onSelection(){}},
    cache:{expired:false}, disposed:false, loading:false, selectionBusy:false,
    selectionIds:complete ? ids : null, async loadSelectionIds(){this.selectionIds=ids;return ids;}, schedule(){},
  });
}

test('header selection covers all 103 groups rather than the 26 rendered rows',async()=>{
  const ids=Array.from({length:103},(_,i)=>String(i));
  const table=selectionTable(ids,ids.slice(0,26));
  assert.equal(table.selectionState().checked,false);
  assert.equal(table.selectionState().indeterminate,true);
  await table.selectAll(true);
  assert.equal(table.options.selected.size,103);
  assert.ok(ids.every(id=>table.options.selected.has(id)));
  assert.equal(table.selectionState().checked,true);
  table.options.selected.delete('102');
  assert.equal(table.selectionState().checked,false);
  assert.equal(table.selectionState().indeterminate,true);
});

test('select all and deselect all preserve records outside the current filter',async()=>{
  const table=selectionTable(['a','b','c'],['outside','b'],true);
  await table.selectAll(true);assert.deepEqual([...table.options.selected],['outside','b','a','c']);
  await table.selectAll(false);assert.deepEqual([...table.options.selected],['outside']);
  assert.equal(table.selectionState().indeterminate,false);
});

test('group picker applies only the current matching selection while retaining other checks as stored',()=>{
  const chosen=new Set(['a','b','c','d']);
  assert.deepEqual(groupSelection(chosen,new Set(['b','d','unselected'])),{finalIds:['b','d'],storedIds:['a','c']});
  assert.deepEqual([...chosen],['a','b','c','d']);
  // 再次切换筛选，之前暂存的勾选可以重新进入最终范围。
  assert.deepEqual(groupSelection(chosen,new Set(['a','c'])),{finalIds:['a','c'],storedIds:['b','d']});
});

test('managing stored groups changes stored count without expanding the final scope',()=>{
  const chosen=new Set(['visible','stored']),matching=new Set(['visible','other']);
  chosen.delete('stored');
  assert.deepEqual(groupSelection(chosen,matching),{finalIds:['visible'],storedIds:[]});
  chosen.add('new-stored');
  assert.deepEqual(groupSelection(chosen,matching),{finalIds:['visible'],storedIds:['new-stored']});
  groupSelection(chosen,matching).storedIds.forEach(id=>chosen.delete(id));
  assert.deepEqual([...chosen],['visible']);
});

test('group picker count and empty scopes work across the full 103-group selection',()=>{
  const chosen=new Set(Array.from({length:103},(_,i)=>String(i)));
  const matching=new Set(Array.from({length:26},(_,i)=>String(i)));
  assert.equal(groupSelection(chosen,matching).finalIds.length,26);
  assert.equal(groupSelection(chosen,matching).storedIds.length,77);
  assert.deepEqual(groupSelection(new Set(),matching),{finalIds:[],storedIds:[]});
  assert.equal(groupSelection(chosen,new Set()).finalIds.length,0);
  assert.equal(groupSelection(chosen,new Set()).storedIds.length,103);
});

test('search commits on submit, ignores composition and clears just the applied keyword', () => {
  const target = () => ({
    listeners: {},
    addEventListener(type, handler) { this.listeners[type] = handler; },
    focus() { this.focused = true; },
  });
  const input = target(), submit = target(), clear = target(), form = target();
  form.querySelector = selector => ({ input, '[type="submit"]': submit, '[type="button"]': clear })[selector];
  const submitted = [];
  const control = mountSearch({ firstElementChild: form }, { label: '搜索成员', value: '原关键词', onSubmit: value => submitted.push(value) });
  const event = { preventDefault() {} };
  input.value = '  测试  ';
  input.listeners.input();
  assert.deepEqual(submitted, []);
  input.listeners.compositionstart();
  form.listeners.submit(event);
  assert.deepEqual(submitted, []);
  input.listeners.compositionend();
  form.listeners.submit(event);
  form.listeners.submit(event);
  assert.deepEqual(submitted, ['测试']);
  assert.equal(input.value, '测试');
  clear.listeners.click();
  assert.deepEqual(submitted, ['测试', '']);
  assert.equal(input.focused, true);
  assert.equal(clear.disabled, true);
  control.setValue('已保存');
  control.setDisabled(true);
  input.value = '其他';
  form.listeners.submit(event);
  assert.deepEqual(submitted, ['测试', '']);
});

test('group search matches the name, remark and ID independently', () => {
  const group = { group_id: '103027', group_name: 'Campus Music', group_remark: '乐团' };
  assert.ok(['', 'music', '乐团', '0302'].every(value => matchesGroup(group, value)));
  assert.equal(matchesGroup(group, '103027 Campus'), false);
});

test('copy and export default to checked rows and allow an explicit all-results choice', () => {
  const checked = new Set();
  assert.equal(operationRange(checked), 'filtered');
  checked.add('10001');
  assert.equal(operationRange(checked), 'selected');
  assert.equal(operationRange(checked, 'filtered'), 'filtered');
  checked.clear();
  assert.equal(operationRange(checked, 'selected'), 'filtered');
});

test('continuing an invitation uses only IDs in the requested result or its checked subset', async () => {
  const originalFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = async url => {
    assert.equal(url, '/api/query/results/filtered-plan/selection');
    reads++;
    return { headers: { get: () => 'application/json' }, json: async () => ({ ok: true, data: { ids: ['10001', '10002', '10003'] } }) };
  };
  const table = { loadSelectionIds: () => readResultIds({
    query_id: 'filtered-plan', total: 3, items: [{ id: '10001' }, { id: 'section', kind: 'group' }],
  }) };
  try {
    assert.deepEqual(await resolveOperationIds(table, ['10002'], () => true), ['10002']);
    assert.equal(reads, 0);
    assert.deepEqual(await resolveOperationIds(table, undefined, () => true), ['10001', '10002', '10003']);
    assert.equal(await resolveOperationIds(table, undefined, () => false), null);
    assert.equal(reads, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('late failures leave the newest result usable and a current failure offers retry', async () => {
  let rejectOld, retry, retries = 0, result, oldIsCurrent;
  const progress = { hidden: true, innerHTML: '', querySelector: () => ({
    addEventListener(type, handler) { assert.equal(type, 'click'); retry = handler; },
  }) };
  const query = new ResultQuery(progress, { isActive: () => true, onChange() {} });
  const old = query.run((report, current) => {
    oldIsCurrent = current;
    return new Promise((resolve, reject) => { rejectOld = reject; });
  }, () => assert.fail('superseded result must not paint'), () => {});
  const show = data => { result = data; };
  await query.run(async () => '最新名单', show, () => {});
  assert.equal(oldIsCurrent(), false);
  rejectOld(new Error('过时的错误'));
  await old;
  assert.equal(query.ready, true);
  assert.equal(progress.hidden, true);
  assert.equal(result, '最新名单');
  await query.run(async () => { throw new Error('当前查询失败'); }, show, () => { retries++; });
  assert.equal(query.ready, false);
  assert.equal(query.loading, false);
  assert.match(progress.innerHTML, /仍显示上次结果/);
  assert.equal(result, '最新名单');
  retry();
  assert.equal(retries, 1);
});

test('legacy tracking, group and member links preserve their parameters', () => {
  const originalWindow = globalThis.window, originalMode = state.workbenchMode;
  const location = { hash: '' };
  globalThis.window = { location, history: { replaceState(state, title, hash) { location.hash = hash; } } };
  try {
    location.hash = '#/groups/rosters?plan=old-plan&job=old-job';
    assert.equal(currentRoute(), 'lists');
    assert.equal(location.hash, '#/lists?plan=old-plan&job=old-job');
    assert.deepEqual([...routeParams()], [['plan', 'old-plan'], ['job', 'old-job']]);
    location.hash = '#/cards';
    assert.equal(currentRoute(), 'members/rename');
    location.hash = '#/cross-members';
    assert.equal(currentRoute(), 'members');
    assert.equal(state.workbenchMode, 'people');
    location.hash = '#/groups?focus=103027';
    assert.equal(currentRoute(), 'groups');
    assert.equal(routeParams().get('focus'), '103027');
  } finally {
    globalThis.window = originalWindow;
    state.workbenchMode = originalMode;
  }
});

test('new results paint immediately with a known selection universe, even before an animation frame',()=>{
  const ids=Array.from({length:450},(_,i)=>String(i));
  let painted = false;
  const table=Object.assign(Object.create(ResultTable.prototype),{
    columns:[],widths:{},viewport:{scrollTop:100},options:{selected:new Set(ids)},
    vertical:{options:{},setOptions(){},measure(){}},reflowColumns(){},
    paint(){ painted = true; },
    schedule(){ assert.fail('the initial paint must run without an animation frame'); },
    loadSelectionIds(){assert.fail('the picker has already resolved the matching IDs');},
  });
  table.setData({items:ids.slice(0,200).map(id=>({id,kind:'record'})),total:450,total_rows:450,query_id:'q',selection_ids:ids});
  assert.equal(painted,true);
  assert.equal(table.selectionState().checked,true);
  assert.equal(table.selectionState().indeterminate,false);
  assert.equal(table.viewport.scrollTop,0);
});

test('all-record selection is atomic, ignores obsolete queries, and permits retry',async()=>{
  const table=selectionTable(['a','b'],['kept']);
  let finish;
  table.loadSelectionIds=()=>new Promise(resolve=>{finish=resolve;});
  const work=table.selectAll(true);
  assert.equal(table.selectionBusy,true);assert.equal(table.selectionState().disabled,true);
  table.loading=true;finish(['a','b']);await work;
  assert.deepEqual([...table.options.selected],['kept']);
  table.loading=false;table.loadSelectionIds=async()=>{throw new Error('网络失败');};
  await table.selectAll(true);assert.deepEqual([...table.options.selected],['kept']);
  assert.equal(table.selectionError.message,'网络失败');assert.equal(table.selectionBusy,false);
  table.loadSelectionIds=async()=>['a','b'];await table.selectAll(true);
  assert.deepEqual([...table.options.selected],['kept','a','b']);
  assert.equal(table.selectionError,null);
});

test('selection handles full member results, group headers, and query replacement',async()=>{
  const ids=Array.from({length:50001},(_,i)=>`10:${i}`);
  const table=selectionTable(ids);
  await table.selectAll(true);assert.equal(table.options.selected.size,50001);
  assert.equal(table.options.selected.has('bucket:0'),false);
  table.selectionIds=['other:1'];table.data={query_id:'other',total:1};
  assert.equal(table.selectionState().checked,false);
  assert.equal(table.selectionState().indeterminate,false);
});

test('group palette assigns distinct colors and keeps identity after sorting and adding groups',()=>{
  const ids=Array.from({length:300},(_,i)=>`group-${i}`);
  const saved=assignGroupColors(ids);
  assert.equal(new Set(ids.map(groupTone)).size,300);
  assert.equal(new Set(ids.map(groupColorStyle)).size,300);
  const before=groupColorStyle('group-7');
  assignGroupColors(['new',...ids.toReversed()],saved);
  assert.equal(groupColorStyle('group-7'),before);
  assert.equal(groupTone('new'),300);
  // 两种主题下，所有基础色都保留足够的文字对比度。
  const luminance = rgb => rgb.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;})
    .reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  for(const id of ids.slice(0,256)) {
    const colors=[...groupColorStyle(id).matchAll(/rgb\((\d+) (\d+) (\d+)\)/g)].map(match=>match.slice(1).map(Number));
    for (const offset of [0,3]) {
      const pair = colors.slice(offset,offset+2).map(luminance).sort((a,b)=>b-a);
      assert.ok((pair[0]+.05)/(pair[1]+.05)>=4.5,`${id}, theme offset ${offset}`);
    }
  }
});

test('data timestamp uses actual read time and Beijing time, never query generation time',()=>{
  assert.equal(dataTimeLabel({created_at:1700001000}), '资料读取时间：未知');
  assert.equal(dataTimeLabel({data_at:1700000000}), '资料读取时间：2023-11-15 06:13:20');
  assert.equal(dataTimeLabel({data_at:1700000000,data_at_end:1700000060,stale:true}),
    '资料读取时间：2023-11-15 06:13:20 ～ 2023-11-15 06:14:20 · 旧缓存，可刷新');
});

test('job polling refreshes once per second without overlapping requests and stops when closed',async()=>{
  const originalFetch=globalThis.fetch, originalWindow=globalThis.window;
  const calls=[],timers=[];let status='running',active=true;
  globalThis.window={setTimeout:(run,delay)=>{timers.push({run,delay});}};
  globalThis.fetch=async path=>{calls.push(path);return {headers:{get:()=> 'application/json'},json:async()=>({ok:true,data:{status}})};};
  try {
    const pending=api.pollJob('job',()=>{},undefined,()=>active);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls.length,1);assert.equal(timers.length,1);
    assert.ok(timers[0].delay>900&&timers[0].delay<=1000);
    status='done';await timers.shift().run();assert.equal((await pending).status,'done');
    const closed=api.pollJob('closed',()=>assert.fail('closed view must not update'),1000,()=>active);
    active=false;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(await closed,null);
  }finally{globalThis.fetch=originalFetch;globalThis.window=originalWindow;}
});

test('background reads hand off to collection and use the finished result without repeating a forced refresh',async()=>{
  const originalFetch=globalThis.fetch;
  const calls=[],progress=[];
  const packets=[
    {pending:true,job:{id:'load-1'}},
    {kind:'load',status:'done',result:{pending:true,job:{id:'collect'}}},
    {kind:'collect',status:'done'},
    {pending:true,job:{id:'load-2'}},
    {kind:'load',status:'done',result:{items:[{id:'complete'}],total:1}},
  ];
  globalThis.fetch=async(path,options)=>{
    calls.push({path,body:options.body&&JSON.parse(options.body)});
    return {headers:{get:()=> 'application/json'},json:async()=>({ok:true,data:packets.shift()})};
  };
  try{
    const data=await requestData('/api/query/start',{refresh:true},job=>progress.push(job));
    assert.equal(data.items[0].id,'complete');
    assert.equal(calls.length,5);
    assert.equal(calls[0].body.background,true);
    assert.equal(calls[0].body.refresh,true);
    assert.equal(calls[3].body.refresh,false);
    assert.equal(progress.at(-1).status,'done');
  }finally{globalThis.fetch=originalFetch;}
});

test('failed background loads surface the error and end the loading indicator',async()=>{
  const originalFetch=globalThis.fetch,progress=[];
  let first=true;
  globalThis.fetch=async()=>({headers:{get:()=> 'application/json'},json:async()=>({ok:true,data:first?(first=false,{pending:true,job:{id:'load'}}):{kind:'load',status:'failed',error:'读取失败',hint:'检查连接',error_code:'NETWORK'}})});
  try{
    await assert.rejects(requestData('/api/query/start',{},job=>progress.push(job)),error=>error.message==='读取失败'&&error.code==='NETWORK');
    assert.equal(progress.at(-1).status,'failed');
  }finally{globalThis.fetch=originalFetch;}
});

test('roster bind and sync use background reads without repeating the operation',async()=>{
  const originalFetch=globalThis.fetch;
  try {
    for(const action of ['bind','sync']) {
      const calls=[];
      globalThis.fetch=async(path,options)=>{
        calls.push({path,body:options.body&&JSON.parse(options.body)});
        return {headers:{get:()=> 'application/json'},json:async()=>({ok:true,data:calls.length===1
          ? {pending:true,job:{id:'roster-read'}}
          : {kind:'load',status:'done',result:{joined:12,not_joined:3}}})};
      };
      const result=await requestData(`/api/rosters/${'a'.repeat(32)}/${action}`,{group_id:'123456'});
      assert.equal(result.joined,12);
      assert.equal(calls.length,2);
      assert.equal(calls[0].body.background,true);
      assert.equal(calls[1].path,'/api/jobs/roster-read');
    }
  }finally{globalThis.fetch=originalFetch;}
});

test('roster table distinguishes pending, joined, missing and left and escapes imported fields',async()=>{
  const {rosterColumns}=await import('../web/js/views/rosters.js');
  const columns=rosterColumns({fields:[{id:'member.qq',label:'QQ号'},{id:'roster.status',label:'入群状态'},{id:'roster.column.0',label:'昵称'}],groups:[],columns:['member.qq','roster.status','roster.column.0']});
  assert.equal(columns[1].label,'入群状态');
  for(const [status,tone,label] of [['joined','success','已入群'],['missing','warning','未入群'],['left','danger','已退群'],['unknown','pending','待核对']]) {
    assert.match(columns[1].render({status}),new RegExp(`field-state-${tone}`));
    assert.match(columns[1].render({status}),new RegExp(label));
  }
  assert.doesNotMatch(columns[2].render({values:{'roster.column.0':'<script>'},display:{'roster.column.0':'<script>'}}),/<script>/);
  assert.equal(columns.some(column=>column.key==='__detail'),false);
});

test('group labels fit without clipping and reserve room for the full-list button', async () => {
  const { fittingTags } = await import('../web/js/field-display.js');
  const more = count => count >= 100 ? 43 : 35;
  assert.equal(fittingTags([80, 80, 80, 80], more, 350), 4);
  assert.equal(fittingTags([80, 80, 80, 80], more, 214), 2);
  assert.equal(fittingTags([400, 80], more, 220), 0);
  assert.equal(fittingTags(Array(104).fill(80), more, 390), 4);
});

test('search highlights literal text case insensitively and escapes result markup', async () => {
  const {highlightText} = await import('../web/js/ui.js');
  assert.equal(highlightText('a.b A.b <x>', 'A.B'),
    '<mark class="search-hit">a.b</mark> <mark class="search-hit">A.b</mark> &lt;x&gt;');
  assert.equal(highlightText('axb', 'a.b'), 'axb');
  assert.match(renderField({group_id:'10', values:{'group.group_name':'师生群'}, display:{'group.group_name':'师生群'}},
    'group.group_name', '—', '师生'), /<mark class="search-hit">师生<\/mark>/);
});

test('vertical virtual table paints keep the same checkbox header', () => {
  const checkbox = {};
  let builds = 0;
  const head = { set innerHTML(_html) { builds++; }, querySelector: () => checkbox };
  const table = Object.assign(Object.create(ResultTable.prototype), {
    data: {total: 10, total_rows: 10}, cache: {expired:false, errors:new Map()}, head, body: {querySelectorAll: () => []},
    canvas: {style:{}}, viewport: {clientWidth:200, scrollTop:0, setAttribute() {}}, status:{},
    options: {selected:new Set(['1'])}, selectionIds:['1','2'],
    pinned: [{key:'__check', width:40, pinned:true}], rest: [],
    vertical: {getVirtualItems: () => [], getTotalSize: () => 480},
    horizontal: {getVirtualItems: () => [], getTotalSize: () => 200}, visibleRows: () => [],
  });
  table.paint();
  table.viewport.scrollTop = 140;
  table.paint();
  assert.equal(builds, 1);
  assert.equal(checkbox.indeterminate, true);
});

test('member details separate account, membership and group fields without duplication',()=>{
  const definitions=['member.qq','member.nickname','member.sex','member.card','member.role','member.join_time','group.group_id','group.my_role','group.raw.info.secret','member.raw.profile.extra'].map(id=>({id}));
  const sections=detailSections(definitions,true);
  assert.deepEqual(sections.map(section=>section.id),['personal','membership','group']);
  assert.deepEqual(sections[0].fields.map(field=>field.id),['member.qq','member.nickname','member.sex']);
  assert.deepEqual(sections[1].fields.map(field=>field.id),['member.card','member.role','member.join_time']);
  assert.deepEqual(sections[2].fields.map(field=>field.id),['group.group_id','group.my_role']);
  assert.equal(new Set(sections.flatMap(section=>section.fields.map(field=>field.id))).size,8);
  assert.deepEqual(detailSections(definitions,false).map(section=>section.id),['group']);
});


test('theme preference defaults to system and explicit choices take priority', async () => {
  const { themePreference, resolveTheme } = await import('../web/js/theme.js');
  for (const value of [undefined, null, '', 'invalid', 'system']) {
    assert.equal(themePreference(value), 'system');
    assert.equal(resolveTheme(value, false), 'light');
    assert.equal(resolveTheme(value, true), 'dark');
  }
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});

test('theme restores browser choice, follows system only when selected, and preserves other preferences', async () => {
  const original = { document:globalThis.document, window:globalThis.window, storage:globalThis.localStorage };
  const stored = new Map([['qqgm.prefs.v1',JSON.stringify({theme:'dark',favoriteGroups:['100']})]]);
  const controls = [{value:''},{value:''}];
  let systemChange;
  const media = {matches:false,addEventListener(type,handler){assert.equal(type,'change');systemChange=handler;}};
  const root = {dataset:{}};
  globalThis.localStorage = {getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value)};
  globalThis.document = {documentElement:root,querySelectorAll:()=>controls,addEventListener(){}};
  globalThis.window = {matchMedia:()=>media};
  try {
    const {initializeTheme,setTheme} = await import('../web/js/theme.js');
    initializeTheme();
    assert.equal(root.dataset.theme,'dark');
    assert.deepEqual(controls.map(c=>c.value),['dark','dark']);
    systemChange();assert.equal(root.dataset.theme,'dark');
    setTheme('system');assert.equal(root.dataset.theme,'light');
    media.matches=true;systemChange();assert.equal(root.dataset.theme,'dark');
    setTheme('light');systemChange();assert.equal(root.dataset.theme,'light');
    assert.deepEqual(JSON.parse(stored.get('qqgm.prefs.v1')),{theme:'light',favoriteGroups:['100']});
    initializeTheme();assert.equal(root.dataset.theme,'light');
  } finally {
    globalThis.document=original.document;globalThis.window=original.window;globalThis.localStorage=original.storage;
  }
});
