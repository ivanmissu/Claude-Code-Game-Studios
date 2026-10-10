/**
 * src/gameplay/buffs.js — 通用增益/减益容器。
 *
 * story-006 要求 buff 系统是通用容器：野怪增益、技能增益（相位步的移速、
 * 君主之刃的攻速/吸血/真实伤害、湮灭的伤害放大）都走同一条路径，
 * 不允许出现三套加成逻辑。
 *
 * 减速（负 move_speed_pct）也走这里，所以慢效果与增益共用生命周期与到期逻辑。
 */
import { emptyModifiers } from './stats.mjs';

export function createBuffList() {
  return { list: [], dirty: true };
}

/**
 * @param {object} bl createBuffList()
 * @param {object} def {id, duration, modifiers?:{flat,pct}, lost_on_death?, team_wide?, source_id?, data?}
 */
export function addBuff(bl, def, now) {
  const existing = bl.list.find(b => b.id === def.id && b.source_id === (def.source_id ?? null));
  if (existing) {                       // 同源同 id：刷新时长，取更强数值
    existing.expires_at = Math.max(existing.expires_at, now + def.duration);
    existing.modifiers = def.modifiers || existing.modifiers;
    bl.dirty = true;
    return existing;
  }
  const b = {
    id: def.id,
    duration: def.duration,
    expires_at: now + def.duration,
    modifiers: def.modifiers || emptyModifiers(),
    lost_on_death: !!def.lost_on_death,
    team_wide: !!def.team_wide,
    source_id: def.source_id ?? null,
    data: def.data || null,
    icon: def.icon || def.id
  };
  bl.list.push(b);
  bl.dirty = true;
  return b;
}

export function removeBuff(bl, id) {
  const i = bl.list.findIndex(b => b.id === id);
  if (i >= 0) { bl.list.splice(i, 1); bl.dirty = true; return true; }
  return false;
}

/** 到期清理；返回本次到期的 buff 数组（供事件用），复用 out 数组避免分配。 */
export function tickBuffs(bl, now, out) {
  out.length = 0;
  for (let i = bl.list.length - 1; i >= 0; i--) {
    if (bl.list[i].expires_at <= now) { out.push(bl.list[i]); bl.list.splice(i, 1); bl.dirty = true; }
  }
  return out;
}

/** 死亡时按 lost_on_death 清除。 */
export function onDeath(bl) {
  let removed = 0;
  for (let i = bl.list.length - 1; i >= 0; i--) {
    if (bl.list[i].lost_on_death) { bl.list.splice(i, 1); removed++; }
  }
  if (removed) bl.dirty = true;
  return removed;
}

/** 把全部 buff 的修正包合并成一个 mods（供 computeStats）。 */
export function aggregateModifiers(bl, out = emptyModifiers()) {
  for (const b of bl.list) {
    const m = b.modifiers;
    if (!m) continue;
    for (const k in m.flat) out.flat[k] = (out.flat[k] || 0) + m.flat[k];
    for (const k in m.pct) out.pct[k] = (out.pct[k] || 0) + m.pct[k];
  }
  return out;
}

export function hasBuff(bl, id) { return bl.list.some(b => b.id === id); }
export function buffRemaining(bl, id, now) {
  const b = bl.list.find(x => x.id === id);
  return b ? Math.max(0, b.expires_at - now) : 0;
}

/** 把野怪增益数据（jungle_camps.json → buffs）转成修正包。 */
export function modifiersFromJungleBuff(buffDef) {
  const mods = emptyModifiers();
  const flatKeys = ['attack_damage', 'ability_power', 'health', 'mana', 'armor', 'magic_resist',
    'health_regen', 'mana_regen', 'on_hit_true_damage'];
  const pctKeys = ['attack_speed_pct', 'move_speed_pct', 'lifesteal_pct', 'cooldown_reduction_pct',
    'ability_damage_pct', 'damage_amp_pct'];
  for (const k of flatKeys) if (buffDef[k]) mods.flat[k] += buffDef[k];
  for (const k of pctKeys) if (buffDef[k]) mods.pct[k] += buffDef[k];
  return mods;
}

/** 把技能的 buff 段（combat_abilities.json）转成修正包。数组值按 rank 取。 */
export function modifiersFromAbilityBuff(buffDef, rank) {
  const mods = emptyModifiers();
  if (!buffDef) return mods;
  const take = v => Array.isArray(v) ? (v[rank - 1] ?? 0) : (v ?? 0);
  const map = {
    attack_damage: 'flat', ability_power: 'flat', health: 'flat', mana: 'flat',
    armor: 'flat', magic_resist: 'flat', health_regen: 'flat', mana_regen: 'flat',
    on_hit_true_damage: 'flat',
    move_speed_pct: 'pct', attack_speed_pct: 'pct', lifesteal_pct: 'pct',
    cooldown_reduction_pct: 'pct', ability_damage_pct: 'pct', damage_amp_pct: 'pct'
  };
  for (const k in map) {
    const v = take(buffDef[k]);
    if (v) mods[map[k]][k] += v;
  }
  return mods;
}
