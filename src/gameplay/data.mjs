/**
 * src/gameplay/data.js — 平衡数据装载。
 *
 * 规则依据 .claude/rules/gameplay-code.md：数值必须数据驱动。
 * 本模块是 gameplay 层唯一读文件的地方；其余模块只接受已装载的 `data` 对象，
 * 因此模拟可以在 Node（测试/无头证据）与浏览器（Canvas）中用同一份代码运行。
 *
 * 数据文件命名遵循 .claude/rules/data-files.md 的 `[system]_[name].json`。
 */

const FILES = {
  map: 'map_lane.json',
  heroes: 'combat_heroes.json',
  abilities: 'combat_abilities.json',
  minions: 'combat_minions.json',
  towers: 'combat_towers.json',
  progression: 'economy_progression.json',
  items: 'economy_items.json',
  jungle: 'jungle_camps.json',
  ai: 'ai_hero.json',
  strings: 'ui_strings.json'
};

const DIR = new URL('../../assets/data/', import.meta.url);

const IS_NODE = typeof process !== 'undefined' && !!process.versions?.node;

async function readOne(name) {
  // Node（测试 / 无头证据渲染）走 fs；浏览器走相对 index.html 的 fetch。
  // 注意：不能用 `typeof fetch === 'function'` 判断环境 —— Node 18+ 也有 fetch，
  // 但它不支持 file:// URL，会让所有离线运行静默失败。
  if (IS_NODE) {
    const fs = await import('node:fs/promises');
    const url = new URL(name, DIR);
    return JSON.parse(await fs.readFile(url, 'utf8'));
  }
  const res = await fetch(`assets/data/${name}`);
  if (!res.ok) throw new Error(`data load failed: ${name} (${res.status})`);
  return res.json();
}

/** @returns {Promise<object>} data — 键为 FILES 的键名 */
export async function loadGameData() {
  const keys = Object.keys(FILES);
  const values = await Promise.all(keys.map(k => readOne(FILES[k])));
  const data = {};
  keys.forEach((k, i) => { data[k] = values[i]; });
  validate(data);
  return data;
}

/**
 * 引用完整性检查——data-files.md 禁止孤儿数据条目。
 * 只抛出确定性错误，不打印建议（core 层不含判决）。
 */
export function validate(data) {
  const err = [];
  const abil = data.abilities.abilities;
  for (const [hid, h] of Object.entries(data.heroes.heroes)) {
    for (const slot of ['passive', 'q', 'w', 'e', 'r']) {
      const id = h.abilities?.[slot];
      if (!id) err.push(`hero ${hid} missing ability slot ${slot}`);
      else if (!abil[id]) err.push(`hero ${hid} → unknown ability "${id}" (${slot})`);
    }
  }
  const items = data.items.items;
  for (const id of data.ai.item_build.route) if (!items[id]) err.push(`ai build → unknown item "${id}"`);
  for (const h of Object.values(data.heroes.heroes)) {
    for (const id of h.starting_items || []) if (!items[id]) err.push(`hero starting item unknown "${id}"`);
  }
  for (const [cid, c] of Object.entries(data.jungle.camps)) {
    if (!data.map.jungle_camps[cid]) err.push(`jungle camp ${cid} has no coordinate in map_lane.json`);
    if (!data.jungle.buffs[c.buff]) err.push(`jungle camp ${cid} → unknown buff "${c.buff}"`);
    for (const m of c.monsters) if (!data.jungle.monster_types[m.type]) err.push(`camp ${cid} → unknown monster "${m.type}"`);
  }
  const strings = data.strings.locales[data.strings.fallback_locale] || {};
  const needKeys = [];
  for (const h of Object.values(data.heroes.heroes)) needKeys.push(h.display_name_key, h.role_key);
  for (const a of Object.values(abil)) needKeys.push(a.name_key, a.desc_key);
  for (const it of Object.values(items)) needKeys.push(it.name_key, it.desc_key);
  for (const t of Object.values(data.minions.types)) needKeys.push(t.display_name_key);
  for (const t of Object.values(data.jungle.monster_types)) needKeys.push(t.display_name_key);
  for (const c of Object.values(data.jungle.camps)) needKeys.push(c.name_key);
  for (const b of Object.values(data.jungle.buffs)) needKeys.push(b.name_key);
  for (const k of needKeys) if (k && !(k in strings)) err.push(`ui_strings missing key "${k}"`);
  const xp = data.progression.xp_to_next;
  if (xp.length !== data.progression.level_max - 1) {
    err.push(`xp_to_next length ${xp.length} ≠ level_max-1 (${data.progression.level_max - 1})`);
  }
  if (err.length) throw new Error('data validation failed:\n  - ' + err.join('\n  - '));
  return true;
}
