import test from 'node:test';
import assert from 'node:assert/strict';
import { bindAutoPage } from '../web/js/pagination.js';

function scroller() {
  const listeners = new Map();
  return {
    scrollTop: 0, scrollHeight: 1000, clientHeight: 400,
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name),
    async scroll(top) { this.scrollTop = top; await listeners.get('scroll')?.(); },
  };
}

test('scroll paging ignores horizontal, upward, non-overflow and final-page scrolls', async () => {
  const list = scroller();
  let count = 0;
  let hasNext = true;
  const unbind = bindAutoPage(list, () => hasNext, () => { count++; });
  await list.scroll(400);
  await list.scroll(400);
  await list.scroll(300);
  assert.equal(count, 0);
  await list.scroll(600);
  assert.equal(count, 1);
  await list.scroll(600);
  assert.equal(count, 1);
  hasNext = false;
  await list.scroll(0); await list.scroll(600);
  assert.equal(count, 1);
  hasNext = true; list.scrollHeight = 400;
  await list.scroll(0); await list.scroll(1);
  assert.equal(count, 1);
  unbind(); list.scrollHeight = 1000;
  await list.scroll(600);
  assert.equal(count, 1);
});

test('scroll paging waits for loading and allows another page after returning to top', async () => {
  const list = scroller();
  let count = 0;
  let finish;
  bindAutoPage(list, () => true, () => {
    count++;
    return new Promise(resolve => { finish = resolve; });
  });
  const loading = list.scroll(590);
  await list.scroll(600);
  assert.equal(count, 1);
  list.scrollTop = 0; finish(); await loading;
  const next = list.scroll(600);
  assert.equal(count, 2);
  finish(); await next;
});

test('a failed page load releases the scroll paging lock', async () => {
  const list = scroller();
  let attempts = 0;
  bindAutoPage(list, () => true, async () => {
    if (++attempts === 1) throw new Error('读取失败');
  });
  await assert.rejects(list.scroll(600), /读取失败/);
  await list.scroll(0); await list.scroll(600);
  assert.equal(attempts, 2);
});

// 筛选组件的状态单元测试，不启动浏览器或连接协议端。
globalThis.document = { getElementById: () => null, addEventListener() {} };
const { FilterBar, catalog } = await import('../web/js/filters.js');
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
