/**
 * src/gameplay/abilities.js — 技能施放与位移。
 *
 * 实现按 `kind` 分派（line / dash / aoe_point / self_buff / projectile_single /
 * shield / passive），所以新增英雄只改 combat_heroes.json + combat_abilities.json，
 * 不改代码（.claude/rules/gameplay-code.md：数据驱动）。
 */
import { clamp, dist, dist2, dirTo } from '../core/math.mjs';
import { EV } from '../core/events.mjs';
import { spawnProjectile, spawnParticles } from './world.mjs';
import { abilityDamage, abilityCost, abilityCooldown } from './stats.mjs';
import { addBuff, modifiersFromAbilityBuff } from './buffs.mjs';
import { startCooldown } from './economy.mjs';

const DIR = { x: 0, y: 0 };

export function abilityOf(world, hero, slot) {
  const id = hero.def.abilities[slot];
  return id ? world.data.abilities.abilities[id] : null;
}

export function canCast(world, hero, slot, aim) {
  if (!hero.alive) return { ok: false, reason: 'dead' };
  if (slot === 'passive') return { ok: false, reason: 'passive' };
  const ability = abilityOf(world, hero, slot);
  if (!ability) return { ok: false, reason: 'unknown' };
  const rank = hero.skillLevels[slot] || 0;
  if (rank <= 0) return { ok: false, reason: 'not_ranked' };
  if ((hero.cooldowns[slot] || 0) > 0) return { ok: false, reason: 'on_cooldown' };
  const cost = abilityCost(ability, rank);
  if (hero.mana < cost) return { ok: false, reason: 'no_mana' };
  if (ability.targeting === 'unit' && !aim?.targetId) return { ok: false, reason: 'no_target' };
  if (ability.targeting === 'unit') {
    const t = world.byId.get(aim.targetId);
    if (!t || !t.alive) return { ok: false, reason: 'no_target' };
    const range = (ability.range || 0) + t.radius;
    if (dist2(hero.x, hero.y, t.x, t.y) > range * range) return { ok: false, reason: 'out_of_range' };
  }
  return { ok: true, ability, rank };
}

/** 施放。aim = {x, y, targetId?}（世界坐标）。 */
export function castAbility(world, hero, slot, aim) {
  const check = canCast(world, hero, slot, aim);
  if (!check.ok) return check;
  const { ability, rank } = check;
  const dmg = abilityDamage(ability, rank, hero.stats);
  hero.mana -= abilityCost(ability, rank);
  startCooldown(world, hero, slot, rank);
  world.events.emit(EV.ABILITY_CAST, { heroId: hero.id, slot, abilityId: ability.id ?? slot, rank });
  spawnParticles(world, world.fx, hero.x, hero.y, 7, { color: 'cast', speedMax: 190, lifeMax: 0.4 });

  switch (ability.kind) {
    case 'line': return castLine(world, hero, ability, rank, dmg, aim);
    case 'dash': return castDash(world, hero, ability, rank, aim);
    case 'aoe_point': return castAoePoint(world, hero, ability, rank, dmg, aim);
    case 'self_buff': return castSelfBuff(world, hero, ability, rank);
    case 'projectile_single': return castSingleTarget(world, hero, ability, rank, dmg, aim);
    case 'shield': return castShield(world, hero, ability, rank);
    default: return { ok: false, reason: 'unimplemented_kind' };
  }
}

/** 把瞄准点钳制到射程内（超射程施放 = 在最大射程处释放，MOBA 惯例）。 */
function clampToRange(world, hero, ability, aim) {
  const range = ability.range || 0;
  const d = dist(hero.x, hero.y, aim.x, aim.y);
  if (d <= range || d < 1e-3) return { x: aim.x, y: aim.y };
  const t = range / d;
  return { x: hero.x + (aim.x - hero.x) * t, y: hero.y + (aim.y - hero.y) * t };
}

function castLine(world, hero, ability, rank, dmg, aim) {
  const p = clampToRange(world, hero, ability, aim);
  if (!dirTo(hero.x, hero.y, p.x, p.y, DIR)) { DIR.x = hero.facing; DIR.y = 0; }
  const life = (ability.range || 600) / (ability.speed || 1000);
  spawnProjectile(world, world.fx, {
    x: hero.x, y: hero.y,
    vx: DIR.x * ability.speed, vy: DIR.y * ability.speed,
    speed: ability.speed, radius: (ability.width || 60) / 2, life,
    ownerId: hero.id, team: hero.team, kind: 'line', color: 'spell',
    homing: false, pierceMinions: !!ability.pierce_minions,
    hitsHeroesOnce: !!ability.hits_heroes_once,
    parts: [{ amount: dmg, damageType: ability.damage_type || 'magic' }],
    slow: ability.slow || null, abilityId: ability.name_key, rank
  });
  return { ok: true };
}

function castDash(world, hero, ability, rank, aim) {
  const p = clampToRange(world, hero, ability, aim);
  hero.dash = { tx: p.x, ty: p.y, speed: ability.dash_speed, until: world.time + 2.0 };
  hero.moveTarget = null;
  if (ability.buff) {
    addBuff(hero.buffs, {
      id: ability.buff.id, duration: ability.buff.duration,
      modifiers: modifiersFromAbilityBuff(ability.buff, rank),
      lost_on_death: true, icon: 'haste'
    }, world.time);
    hero.statsDirty = true;
  }
  spawnParticles(world, world.fx, hero.x, hero.y, 10, { color: 'dash', speedMax: 210, lifeMax: 0.45 });
  return { ok: true };
}

function castAoePoint(world, hero, ability, rank, dmg, aim) {
  const p = clampToRange(world, hero, ability, aim);
  world.effects.push({
    kind: 'telegraph', x: p.x, y: p.y, radius: ability.radius,
    spawnAt: world.time, detonateAt: world.time + (ability.delay_sec || 0.5),
    life: (ability.delay_sec || 0.5) + 0.6, ownerId: hero.id, team: hero.team,
    damage: dmg, damageType: ability.damage_type || 'magic',
    slow: ability.slow || null, abilityId: ability.name_key, color: 'telegraph'
  });
  return { ok: true };
}

function castSelfBuff(world, hero, ability, rank) {
  addBuff(hero.buffs, {
    id: ability.buff.id, duration: ability.duration,
    modifiers: modifiersFromAbilityBuff(ability.buff, rank),
    lost_on_death: true, icon: ability.buff.id
  }, world.time);
  hero.statsDirty = true;
  spawnParticles(world, world.fx, hero.x, hero.y, 16, { color: 'buff', speedMax: 170, lifeMax: 0.7 });
  return { ok: true };
}

function castSingleTarget(world, hero, ability, rank, dmg, aim) {
  const t = world.byId.get(aim.targetId);
  if (!t) return { ok: false, reason: 'no_target' };
  spawnProjectile(world, world.fx, {
    x: hero.x, y: hero.y, speed: ability.speed || 900, radius: ability.radius || 14,
    life: 3.0, ownerId: hero.id, team: hero.team, targetId: t.id,
    homing: true, kind: 'spell', color: 'spell',
    parts: [{ amount: dmg, damageType: ability.damage_type || 'magic' }],
    slow: ability.slow || null, abilityId: ability.name_key, rank
  });
  return { ok: true };
}

function castShield(world, hero, ability, rank) {
  const s = ability.shield;
  const value = (s.base + s.per_rank * (rank - 1) + (s.ratio_ad || 0) * hero.stats.attack_damage
    + (s.ratio_ap || 0) * hero.stats.ability_power) * (1 + hero.stats.ability_damage_pct);
  hero.shield += value;
  if (ability.buff) {
    addBuff(hero.buffs, {
      id: ability.buff.id, duration: ability.buff.duration,
      modifiers: modifiersFromAbilityBuff(ability.buff, rank),
      lost_on_death: true, icon: 'shield'
    }, world.time);
    hero.statsDirty = true;
  }
  spawnParticles(world, world.fx, hero.x, hero.y, 12, { color: 'shield', speedMax: 140, lifeMax: 0.5 });
  return { ok: true, shield: value };
}

/** 位移（相位步）：以 dash_speed 覆盖普通移速，直到抵达目标点。 */
export function updateDashes(world, dt) {
  for (const hero of world.heroes) {
    if (!hero.alive || !hero.dash) continue;
    const d = hero.dash;
    const step = d.speed * dt;
    const remaining = dist(hero.x, hero.y, d.tx, d.ty);
    if (remaining <= step || world.time > d.until) {
      hero.x = d.tx; hero.y = d.ty;
      hero.dash = null;
      continue;
    }
    if (dirTo(hero.x, hero.y, d.tx, d.ty, DIR)) {
      hero.x += DIR.x * step; hero.y += DIR.y * step;
      hero.facing = DIR.x >= 0 ? 1 : -1;
    }
  }
}
