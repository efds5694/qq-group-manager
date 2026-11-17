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
const { ResultTable } = await import('../web/js/result-table.js');
const { loadPrefs, savePrefs } = await import('../web/js/state.js');
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
  assert.ok(tone>=0&&tone<8);
  assert.doesNotMatch(groupTag('<script>"','675085435'),/<script>/);
  assert.match(renderField({values:{},display:{'member.age':'采集失败'}},'member.age'),/field-state-danger/);
  assert.doesNotMatch(renderField({values:{'member.nickname':'采集失败'},display:{'member.nickname':'采集失败'}},'member.nickname'),/field-state-danger/);
  assert.match(renderField({values:{'comparison.status':'missing','member.card':''},display:{}},'member.card'),/未加入/);
  assert.match(renderField({values:{'member.muted':true},display:{'member.muted':'是'}},'member.muted'),/field-state-warning/);
  assert.match(renderField({values:{'comparison.source_groups':['改名后的群']},display:{},source_group_ids:['675085435']},'comparison.source_groups'),new RegExp(`group-tone-${tone}`));
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
