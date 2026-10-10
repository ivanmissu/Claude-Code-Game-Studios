/**
 * src/gameplay/stats.js — 属性计算（纯函数）。
 *
 * story-005 验收标准："同一状态重算两次结果相同"。因此这里没有缓存、没有全局、
 * 没有副作用：输入 (英雄数据, 等级, 技能等级, 物品, buff 修正包) → 输出属性对象。
 * 缓存由 world 层负责（statsDirty 标记），不在本模块。
 */
import { clamp } from '../core/math.mjs';

/** 与 assets/data/economy_items.json 的 `_doc["stat keys"]` 一一对应（测试断言）。 */
export const ITEM_STAT_KEYS = Object.freeze([
  'health', 'mana', 'attack_damage', 'ability_power', 'armor', 'magic_resist',
  'attack_speed_pct', 'move_speed_pct', 'health_regen', 'mana_regen',
  'lifesteal_pct', 'cooldown_reduction_pct', 'armor_penetration_flat',
  'magic_penetration_flat', 'ability_damage_pct'
]);

export const LIMITS = Object.freeze({
  attack_speed: [0.1, 2.5],
  move_speed: [110, 620],
  cooldown_reduction: [0, 0.45],
  lifesteal: [0, 0.9],
  ability_damage_pct: [0, 2],
  damage_amp_pct: [0, 2]
});

/** 空的修正包——buffs.mjs 与 economy.mjs 都往这个形状里累加。 */
export function emptyModifiers() {
  return {
    flat: { health: 0, mana: 0, attack_damage: 0, ability_power: 0, armor: 0, magic_resist: 0, health_regen: 0, mana_regen: 0, on_hit_true_damage: 0, armor_penetration_flat: 0, magic_penetration_flat: 0 },
    pct: { attack_speed_pct: 0, move_speed_pct: 0, lifesteal_pct: 0, cooldown_reduction_pct: 0, ability_damage_pct: 0, damage_amp_pct: 0 }
  };
}

/** 把一件物品的 stats 累加进修正包。 */
export function addItemModifiers(mods, item) {
  const s = item?.stats;
  if (!s) return mods;
  for (const k of ITEM_STAT_KEYS) {
    const v = s[k];
    if (!v) continue;
    if (k.endsWith('_pct')) mods.pct[k] += v;
    else mods.flat[k] += v;
  }
  return mods;
}

/**
 * @param {object} heroData combat_heroes.json 中的英雄条目
 * @param {number} level
 * @param {object} mods emptyModifiers() 形状（物品 + buff 已累加）
 * @returns {object} stats
 */
export function computeStats(heroData, level, mods) {
  const g = level - 1;
  const hp = heroData.health + heroData.growth_health * g + mods.flat.health;
  const mp = heroData.mana + heroData.growth_mana * g + mods.flat.mana;
  const asBase = heroData.attack_speed + heroData.growth_attack_speed * g;
  return {
    max_health: hp,
    max_mana: mp,
    health_regen: heroData.health_regen + heroData.growth_health_regen * g + mods.flat.health_regen,
    mana_regen: heroData.mana_regen + heroData.growth_mana_regen * g + mods.flat.mana_regen,
    attack_damage: heroData.attack_damage + heroData.growth_attack_damage * g + mods.flat.attack_damage,
    ability_power: heroData.ability_power + heroData.growth_ability_power * g + mods.flat.ability_power,
    armor: heroData.armor + heroData.growth_armor * g + mods.flat.armor,
    magic_resist: heroData.magic_resist + heroData.growth_magic_resist * g + mods.flat.magic_resist,
    attack_speed: clamp(asBase * (1 + mods.pct.attack_speed_pct), ...LIMITS.attack_speed),
    move_speed: clamp(heroData.move_speed * (1 + mods.pct.move_speed_pct), ...LIMITS.move_speed),
    attack_range: heroData.attack.range,
    lifesteal_pct: clamp(mods.pct.lifesteal_pct, ...LIMITS.lifesteal),
    cooldown_reduction_pct: clamp(mods.pct.cooldown_reduction_pct, ...LIMITS.cooldown_reduction),
    ability_damage_pct: clamp(mods.pct.ability_damage_pct, ...LIMITS.ability_damage_pct),
    damage_amp_pct: clamp(mods.pct.damage_amp_pct, ...LIMITS.damage_amp_pct),
    on_hit_true_damage: mods.flat.on_hit_true_damage,
    armor_penetration_flat: mods.flat.armor_penetration_flat,
    magic_penetration_flat: mods.flat.magic_penetration_flat
  };
}

/** 建筑/小兵/中立怪的属性：无成长，直接取数据 + 时间缩放。 */
export function computeUnitStats(def, scalePct = 0) {
  return {
    max_health: def.health * (1 + scalePct),
    attack_damage: def.attack_damage * (1 + scalePct),
    armor: def.armor,
    magic_resist: def.magic_resist,
    attack_range: def.attack_range,
    attack_interval: def.attack_interval,
    move_speed: def.move_speed,
    damage_type: def.damage_type || 'physical',
    windup_sec: def.windup_sec || 0,
    projectile_speed: def.projectile_speed ?? null,
    bonus_damage_vs_structures: def.bonus_damage_vs_structures ?? 1
  };
}

/**
 * 技能数值：base + per_rank*(rank-1) + ratio_ad*AD + ratio_ap*AP。
 * @returns {number} rank ≤ 0 时返回 0（未加点的技能不造成伤害）
 */
export function abilityDamage(ability, rank, stats) {
  if (!ability?.damage || rank <= 0) return 0;
  const d = ability.damage;
  const raw = d.base + d.per_rank * (rank - 1) + (d.ratio_ad || 0) * stats.attack_damage + (d.ratio_ap || 0) * stats.ability_power;
  return raw * (1 + stats.ability_damage_pct) * (1 + stats.damage_amp_pct);
}

/** 冷却时间，应用冷却缩减。 */
export function abilityCooldown(ability, rank, stats) {
  const cd = ability.cooldown?.[rank - 1] ?? 0;
  return Math.max(0, cd * (1 - stats.cooldown_reduction_pct));
}

export function abilityCost(ability, rank) { return ability.cost?.[rank - 1] ?? 0; }

/** 经验曲线：从 level 升到 level+1 所需经验。 */
export function xpToNext(progression, level) {
  if (level >= progression.level_max) return Infinity;
  return progression.xp_to_next[level - 1] ?? Infinity;
}

/** 复活时间：min(max, base + per_level*(level-1))。 */
export function respawnTime(progression, level) {
  const r = progression.respawn;
  return Math.min(r.max_sec, r.base_sec + r.per_level_sec * (level - 1));
}
