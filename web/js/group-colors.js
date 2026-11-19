import { GROUP_PALETTE } from '../vendor/colorcet/glasbey-category10.js';

let tones = new Map();
let nextTone = 0;

// 分配而非取模，避免不同群碰巧撞色；历史映射由账号的浏览器配置保存。
export function assignGroupColors(ids, saved = {}) {
  tones = new Map(Object.entries(saved).filter(([, tone]) => Number.isInteger(tone) && tone >= 0));
  nextTone = tones.size ? Math.max(...tones.values()) + 1 : 0;
  ids.forEach(groupTone);
  return Object.fromEntries(tones);
}

export function groupTone(id) {
  const key = String(id);
  if (!tones.has(key)) tones.set(key, nextTone++);
  return tones.get(key);
}

export function groupColorStyle(id) {
  const tone = groupTone(id);
  const cycle = Math.floor(tone / GROUP_PALETTE.length);
  const color = GROUP_PALETTE[tone % GROUP_PALETTE.length];
  // 256 色用完后仍从经典色开始，以不同亮度继续区分。
  const tint = .22 * (1 - 1 / (cycle + 1));
  const base = color.map(value => value + (255 - value) * tint);
  const mix = (target, amount) => base.map((value, index) => Math.round(value * (1 - amount) + target[index] * amount)).join(' ');
  return `--group-dark-bg:rgb(${mix([15,23,34], .64)});--group-dark-text:rgb(${mix([255,255,255], .80)});--group-dark-line:rgb(${mix([30,40,56], .32)});--group-light-bg:rgb(${mix([255,255,255], .77)});--group-light-text:rgb(${mix([15,23,34], .82)});--group-light-line:rgb(${mix([73,88,105], .32)})`;
}
