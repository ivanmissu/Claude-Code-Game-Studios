/**
 * src/gameplay/combat.js — 统一伤害管线、目标选择、普攻、弹道与延迟效果。
 *
 * 规则依据 .claude/rules/gameplay-code.md：所有数值来自 data；一切推进都用 dt。
 * 所有伤害（普攻/技能/塔/持续）都必须走 applyDamage，这样护盾、无敌建筑、
 * 生命偷取、死亡结算、统计只有一处实现，不会出现"某个来源绕过了护甲"的漏洞。
 */
import { dist, dist2, clamp } from '../core/math.mjs';
import { EV } from '../core/events.mjs';
import {
  queryNear, isHostileTo, removeEntity, spawnProjectile, spawnParticles,
  spawnFloatText, TEAMS
} from './world.mjs';
import { abilityDamage } from './stats.mjs';
import { onDeath } from './buffs.mjs';
import { awardLastHit, awardHeroKill, awardStructureBounty } from './economy.mjs';
import { refreshInvulnerability, checkVictory, onCampCleared } from './objectives.mjs';

const NEAR = [];          // 模块级复用缓冲：queryNear 的输出（零分配热路径）
const NEAR2 = [];

/* ---------------------------------------------------------------- 伤害 */
function resistOf(target, type) {
  const s = target.stats;
  if (!s) return 0;
  if (type === 'physical') return s.armor ?? 0;
  if (type === 'magic') return s.magic_resist ?? 0;
  return 0;
}

/** 减伤公式：dmg * 100/(100+resist)；穿透先扣抗性的固定值。 */
export function mitigate(amount, type, target, attackerStats) {
  if (type === 'true') return amount;
  const pen = type === 'physical' ? (attackerStats?.armor_penetration_flat ?? 0)
    : (attackerStats?.magic_penetration_flat ?? 0);
  const resist = Math.max(0, resistOf(target, type) - pen);
  return amount * (100 / (100 + resist));
}

/**
 * @param opts {source?, damageType, isAbility?, abilityId?, silent?, rampTrue?}
 * @returns {number} 实际造成的伤害（0 = 被无敌/护盾吸收完毕）
 */
export function applyDamage(world, target, rawAmount, opts = {}) {
  if (!target || !target.alive || rawAmount <= 0) return 0;
  if (target.invulnerable) {
    world.events.emit('damage_blocked', { targetId: target.id, reason: 'invulnerable' });
    return 0;
  }
  const source = opts.source;
  const type = opts.damageType || 'physical';
  let amount = mitigate(rawAmount, type, target, source?.stats);
  // 护盾先吃伤害
  if (target.shield > 0) {
    const absorbed = Math.min(target.shield, amount);
    target.shield -= absorbed;
    amount -= absorbed;
  }
  target.health -= amount;
  target.hitFlash = 0.14;
  if (source && source.kind === 'hero' && source.stats?.lifesteal_pct && !opts.isAbility) {
    source.health = Math.min(source.stats.max_health, source.health + rawAmount * source.stats.lifesteal_pct);
  }
  if (source && source.kind === 'hero') source.damageDealt += amount;
  // 中立怪被攻击 → 记仇恨与"最后攻击方阵营"（决定经验归属）
  if (target.team === 'neutral' && source) {
    target.aggroTargetId = source.id;
    target.lastAttackerTeam = source.team;
  }
  if (amount > 0 && !opts.silent) {
    spawnFloatText(world, world.fx, target.x, target.y - target.radius - 6,
      String(Math.round(amount)), type === 'true' ? 'true' : (type === 'magic' ? 'magic' : 'physical'),
      opts.isAbility ? 16 : 13);
    if (opts.isAbility) {
      spawnParticles(world, world.fx, target.x, target.y, 6, { color: 'spell', speedMax: 150, lifeMax: 0.4 });
    }
  }
  world.events.emit(EV.DAMAGE_DEALT, { targetId: target.id, sourceId: source?.id ?? 0, amount, type });
  if (target.health <= 0) {
    target.health = 0;
    kill(world, target, source, opts);
  }
  return amount;
}

export function kill(world, e, killer, opts = {}) {
  if (!e.alive) return;
  e.alive = false;
  e.deathAt = world.time;
  e.moveTarget = null;
  e.targetId = 0;
  e.windup = 0;
  spawnParticles(world, world.fx, e.x, e.y, e.kind === 'hero' ? 26 : 12, {
    color: e.team === 'radiant' ? 'teamRadiant' : (e.team === 'dire' ? 'teamDire' : 'neutral'),
    speedMax: e.kind === 'hero' ? 260 : 170, lifeMax: e.kind === 'hero' ? 0.9 : 0.55,
    sizeMax: e.kind === 'hero' ? 6 : 4
  });
  if (e.kind === 'hero') {
    onDeath(e.buffs);
    e.statsDirty = true;
    awardHeroKill(world, e, killer);
  } else if (e.kind === 'structure') {
    awardStructureBounty(world, e, killer);
    world.events.emit(EV.STRUCTURE_DESTROYED, {
      structureId: e.id, team: e.team, kind: e.structureKind, killerId: killer?.id ?? 0
    });
    removeEntity(world, e);
    refreshInvulnerability(world);
    checkVictory(world);
  } else {
    awardLastHit(world, e, killer);
    world.events.emit(EV.UNIT_DIED, { unitId: e.id, kind: e.kind, team: e.team, typeId: e.typeId, killerId: killer?.id ?? 0 });
    if (e.kind === 'neutral') {
      const camp = world.camps[e.campId];
      if (camp) {
        camp.units = camp.units.filter(id => id !== e.id);
        if (!camp.units.length) {
          const team = killer?.team && killer.team !== 'neutral' ? killer.team
            : (e.lastAttackerTeam ?? null);
          if (team) onCampCleared(world, camp, killer, team);
        }
      }
    }
    removeEntity(world, e);
  }
}

/* ---------------------------------------------------------------- 目标选择 */
export function nearestHostile(world, e, radius, kindFilter = null) {
  queryNear(world, e.x, e.y, radius, NEAR, kindFilter);
  let best = null, bestD = Infinity;
  for (let i = 0; i < NEAR.length; i++) {
    const t = NEAR[i];
    if (!isHostileTo(e, t)) continue;
    if (t.invulnerable && e.kind !== 'hero') continue;
    const d = dist2(e.x, e.y, t.x, t.y);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

/**
 * 小兵仇恨优先级（story-002）：正在攻击我方的敌人 > 敌方小兵 > 敌方英雄。
 * 找不到敌人时，若已进入 structure_fallback.range 则攻击建筑（兵线推塔的原因）。
 */
export function findMinionTarget(world, m) {
  const aggro = world.data.minions.aggro;
  const fbCfg = world.data.minions.structure_fallback;
  // 贴着可打的建筑就拆建筑（哪怕身边有敌方小兵）：否则兵线只会在中路无限对消，
  // 塔血量可以长时间一动不动 —— 一局永远推不完。详见 combat_minions.json 的 _doc_siege。
  if (fbCfg?.enabled && fbCfg.siege_when_adjacent) {
    const s = findFallbackStructure(world, m);
    if (s) return s;
  }
  queryNear(world, m.x, m.y, aggro.acquire_radius, NEAR);
  let attackingAlly = null, minion = null, hero = null;
  let dAtt = Infinity, dMin = Infinity, dHero = Infinity;
  for (let i = 0; i < NEAR.length; i++) {
    const t = NEAR[i];
    if (!isHostileTo(m, t)) continue;
    const d = dist2(m.x, m.y, t.x, t.y);
    const threatensAlly = t.targetId && world.byId.get(t.targetId)?.team === m.team;
    if (threatensAlly && d < dAtt) { dAtt = d; attackingAlly = t; }
    else if (t.kind === 'minion' && d < dMin) { dMin = d; minion = t; }
    else if (t.kind === 'hero' && d < dHero) { dHero = d; hero = t; }
  }
  return attackingAlly || minion || hero || null;
}

/** 小兵找不到敌人时的建筑回退目标。 */
export function findFallbackStructure(world, m) {
  const fb = world.data.minions.structure_fallback;
  if (!fb?.enabled) return null;
  queryNear(world, m.x, m.y, fb.range, NEAR2, 'structure');
  let best = null, bestD = Infinity;
  for (const t of NEAR2) {
    if (t.team === m.team || t.invulnerable) continue;
    const d = dist2(m.x, m.y, t.x, t.y);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

/**
 * 塔目标优先级（story-003）：攻击友方英雄的敌方英雄 > 最近小兵 > 最近英雄。
 * 锁定后 retarget_interval_sec 内不换目标，除非目标死亡或离开射程。
 */
export function findStructureTarget(world, s) {
  const range = s.stats.attack_range;
  if (s.targetId && world.time < s.retargetAt) {
    const cur = world.byId.get(s.targetId);
    if (cur && cur.alive && dist2(s.x, s.y, cur.x, cur.y) <= (range + cur.radius) ** 2) return cur;
  }
  queryNear(world, s.x, s.y, range, NEAR);
  let avenger = null, minion = null, hero = null;
  let dA = Infinity, dM = Infinity, dH = Infinity;
  for (let i = 0; i < NEAR.length; i++) {
    const t = NEAR[i];
    if (t.team === s.team || t.team === 'neutral' || !t.alive) continue;
    const d = dist2(s.x, s.y, t.x, t.y);
    if (d > (range + t.radius) ** 2) continue;
    if (t.kind === 'hero') {
      const victim = world.byId.get(t.targetId);
      if (victim && victim.team === s.team && victim.kind === 'hero' && d < dA) { dA = d; avenger = t; }
      if (d < dH) { dH = d; hero = t; }
    } else if (t.kind === 'minion' && d < dM) { dM = d; minion = t; }
  }
  const chosen = avenger || minion || hero || null;
  s.targetId = chosen?.id ?? 0;
  s.retargetAt = world.time + world.data.towers.tower.retarget_interval_sec;
  return chosen;
}

/* ---------------------------------------------------------------- 普攻 */
/** 计算一次普攻的伤害构成：基础 + 对建筑加成 + 塔的递增 + 被动 + 命中真实伤害。 */
export function attackDamageParts(world, attacker, target) {
  const s = attacker.stats;
  const parts = [];
  let base = s.attack_damage;
  if (target.kind === 'structure') base *= (s.bonus_damage_vs_structures ?? 1) * (attacker.bonusVsStructures ?? 1);
  let type = s.damage_type || (attacker.def?.attack?.damage_type ?? 'physical');
  if (attacker.kind === 'hero') {
    type = attacker.def.attack.damage_type;
    base = s.attack_damage;
    if (target.kind === 'structure') base *= (s.bonus_damage_vs_structures ?? 1);
  }
  parts.push({ amount: base, damageType: type });

  // 塔的递增伤害：连续命中同一英雄时按 per_hit 递增，递增部分按真实伤害结算
  if (attacker.kind === 'structure' && target.kind === 'hero') {
    const ramp = attacker.def.hero_damage_ramp;
    if (world.time > attacker.rampResetAt || attacker.rampTargetId !== target.id) {
      attacker.rampTargetId = target.id; attacker.rampHits = 0;
    }
    attacker.rampHits = Math.min(99, attacker.rampHits + 1);
    attacker.rampResetAt = world.time + ramp.reset_sec;
    const mult = clamp(1 + ramp.per_hit * (attacker.rampHits - 1), 1, ramp.max);
    if (mult > 1) {
      const extra = base * (mult - 1);
      parts.push({ amount: extra, damageType: attacker.def.ramp_true_damage ? 'true' : type });
    }
  }

  // 英雄被动：每第 N 次普攻附加伤害
  if (attacker.kind === 'hero') {
    const passiveId = attacker.def.abilities.passive;
    const passive = world.data.abilities.abilities[passiveId];
    const rank = attacker.skillLevels.passive || 0;
    if (passive?.every_n_attacks && rank > 0) {
      const n = attacker.attackCounter + 1;
      if (n % passive.every_n_attacks === 0) {
        parts.push({ amount: abilityDamage(passive, rank, s), damageType: passive.damage_type, isAbility: true });
      }
    }
    if (s.on_hit_true_damage > 0) parts.push({ amount: s.on_hit_true_damage, damageType: 'true' });
  }
  return parts;
}

export function performAttack(world, attacker, target) {
  attacker.attackCounter++;
  const parts = attackDamageParts(world, attacker, target);
  const s = attacker.stats;
  const speed = s.projectile_speed ?? attacker.def?.attack?.projectile_speed ?? null;
  if (speed) {
    spawnProjectile(world, world.fx, {
      x: attacker.x, y: attacker.y, speed, radius: attacker.kind === 'hero' ? 9 : 7,
      life: 3.0, ownerId: attacker.id, team: attacker.team, targetId: target.id,
      homing: true, kind: 'attack', color: attacker.team === 'radiant' ? 'teamRadiant' : 'teamDire',
      damage: 0, damageType: 'physical', parts, abilityId: null, rank: 0
    });
  } else {
    for (const p of parts) {
      applyDamage(world, target, p.amount, { source: attacker, damageType: p.damageType, isAbility: !!p.isAbility });
    }
    spawnParticles(world, world.fx, target.x, target.y, 3, { color: 'hit', speedMax: 110, lifeMax: 0.28, sizeMax: 3 });
  }
}

/** 进入攻击节奏：冷却 → 前摇（windup）→ 出手。前摇期间目标死亡则取消。 */
function updateAttackRhythm(world, e, dt) {
  if (e.attackCooldown > 0) e.attackCooldown -= dt;
  if (e.windup > 0) {
    e.windup -= dt;
    const target = world.byId.get(e.windupTargetId);
    if (!target || !target.alive) { e.windup = 0; e.windupTargetId = 0; return; }
    if (e.windup <= 0) {
      performAttack(world, e, target);
      e.windup = 0; e.windupTargetId = 0;
      const interval = e.kind === 'hero' ? 1 / e.stats.attack_speed : e.stats.attack_interval;
      e.attackCooldown = interval;
    }
    return;
  }
  const target = world.byId.get(e.targetId);
  if (!target || !target.alive) return;
  const range = (e.stats.attack_range ?? 0) + target.radius + e.radius;
  if (dist2(e.x, e.y, target.x, target.y) > range * range) return;
  if (e.attackCooldown > 0) return;
  e.windup = e.stats.windup_sec ?? e.def?.attack?.windup_sec ?? 0.2;
  e.windupTargetId = target.id;
}

/* ---------------------------------------------------------------- 每 tick 战斗 */
export function updateCombat(world, dt) {
  const ents = world.entities;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (!e.alive) continue;
    if (e.hitFlash > 0) e.hitFlash -= dt;
    if (e.kind === 'structure') {
      const t = findStructureTarget(world, e);
      if (t) { e.targetId = t.id; updateAttackRhythm(world, e, dt); }
      continue;
    }
    if (e.kind === 'minion') {
      const t = findMinionTarget(world, e);
      if (t) { e.targetId = t.id; e.moveTarget = null; updateAttackRhythm(world, e, dt); }
      else {
        const fb = findFallbackStructure(world, e);
        if (fb) { e.targetId = fb.id; updateAttackRhythm(world, e, dt); }
        else { e.targetId = 0; e.attackCooldown = Math.max(0, e.attackCooldown - dt); }
      }
      continue;
    }
    if (e.kind === 'neutral') {
      // 中立怪的攻击目标由 ai/neutral_ai.mjs 决定（牵引/返回），这里只跑节奏
      updateAttackRhythm(world, e, dt);
      continue;
    }
    if (e.kind === 'hero') updateAttackRhythm(world, e, dt);
  }
}

/* ---------------------------------------------------------------- 弹道与延迟效果 */
export function updateProjectiles(world, dt) {
  const list = world.projectiles;
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    p.life -= dt;
    let dead = p.life <= 0;
    if (p.homing) {
      const t = world.byId.get(p.targetId);
      if (!t || !t.alive) { dead = true; }
      else {
        const dx = t.x - p.x, dy = t.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        const step = p.speed * dt;
        p.x += (dx / len) * step; p.y += (dy / len) * step;
        if (len <= step + t.radius) {
          deliverProjectile(world, p, t);
          dead = true;
        }
      }
    } else {
      const px = p.x, py = p.y;
      p.x += p.vx * dt; p.y += p.vy * dt;
      // 线段 vs 圆：避免高速弹道穿透（tunneling）
      queryNear(world, p.x, p.y, 120, NEAR);
      for (let k = 0; k < NEAR.length; k++) {
        const t = NEAR[k];
        if (!isProjectileTarget(world, p, t)) continue;
        if (p.hitIds.includes(t.id)) continue;
        const rr = t.radius + p.radius;
        if (!segmentCircleHit(px, py, p.x, p.y, t.x, t.y, rr)) continue;
        p.hitIds.push(t.id);
        if (p.kind === 'line') {
          for (const part of p.parts || []) {
            applyDamage(world, t, part.amount, {
              source: world.byId.get(p.ownerId), damageType: part.damageType,
              isAbility: true, abilityId: p.abilityId
            });
          }
          if (p.slow) applySlow(world, t, p.slow, p.ownerId);
          spawnParticles(world, world.fx, t.x, t.y, 5, { color: 'spell', speedMax: 140, lifeMax: 0.35 });
          if (t.kind === 'hero' && p.hitsHeroesOnce) dead = true;
          if (!p.pierceMinions && t.kind === 'minion') dead = true;
        } else {
          deliverProjectile(world, p, t);
          dead = true;
        }
        if (dead) break;
      }
    }
    if (dead) {
      world.projectiles.splice(i, 1);
      world.fx.projectiles.release(p);
    }
  }
}

function isProjectileTarget(world, p, t) {
  if (t.id === p.ownerId || !t.alive) return false;
  // 阵营不同即为合法目标：中立怪与双方英雄互为敌对（技能可以打 into 野区）
  return t.team !== p.team;
}

function deliverProjectile(world, p, target) {
  const owner = world.byId.get(p.ownerId);
  if (p.parts && p.parts.length) {
    for (const part of p.parts) {
      applyDamage(world, target, part.amount, {
        source: owner, damageType: part.damageType, isAbility: !!p.abilityId, abilityId: p.abilityId
      });
    }
  } else if (p.damage > 0) {
    applyDamage(world, target, p.damage, { source: owner, damageType: p.damageType, isAbility: !!p.abilityId });
  }
  if (p.slow) applySlow(world, target, p.slow, p.ownerId);
}

function applySlow(world, target, slow, ownerId) {
  if (!target.buffs) return;
  const mods = { flat: {}, pct: { move_speed_pct: slow.move_speed_pct } };
  target.buffs.list.push({
    id: `slow_${ownerId}_${Math.round(world.time * 10)}`,
    duration: slow.duration, expires_at: world.time + slow.duration,
    modifiers: mods, lost_on_death: true, team_wide: false,
    source_id: ownerId, data: null, icon: 'slow'
  });
  target.buffs.dirty = true;
  target.statsDirty = true;
}

function segmentCircleHit(ax, ay, bx, by, cx, cy, r) {
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby || 1e-9;
  let t = ((cx - ax) * abx + (cy - ay) * aby) / len2;
  t = clamp(t, 0, 1);
  const px = ax + abx * t, py = ay + aby * t;
  return dist2(px, py, cx, cy) <= r * r;
}

/** 延迟效果（aoe_point 的读条落点）结算。 */
export function updateEffects(world, dt) {
  for (let i = world.effects.length - 1; i >= 0; i--) {
    const fx = world.effects[i];
    fx.life -= dt;
    if (fx.kind === 'telegraph' && world.time >= fx.detonateAt) {
      queryNear(world, fx.x, fx.y, fx.radius, NEAR);
      for (const t of NEAR) {
        if (!isHostileTo(world.byId.get(fx.ownerId) || { team: fx.team }, t)) continue;
        if (t.kind === 'neutral' && fx.team !== 'neutral' && t.aggroTargetId !== fx.ownerId) continue;
        applyDamage(world, t, fx.damage, {
          source: world.byId.get(fx.ownerId), damageType: fx.damageType, isAbility: true, abilityId: fx.abilityId
        });
        if (fx.slow) applySlow(world, t, fx.slow, fx.ownerId);
      }
      spawnParticles(world, world.fx, fx.x, fx.y, 18, { color: 'spell', speedMax: 260, lifeMax: 0.6, sizeMax: 5 });
      world.effects.splice(i, 1);
      continue;
    }
    if (fx.life <= 0) world.effects.splice(i, 1);
  }
}

/** 粒子与伤害数字（纯表现，但状态存在模拟里以便无头渲染同一帧）。 */
export function updateParticles(world, dt) {
  for (let i = world.particles.length - 1; i >= 0; i--) {
    const p = world.particles[i];
    p.life -= dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= 0.94; p.vy *= 0.94;
    if (p.life <= 0) { world.particles.splice(i, 1); world.fx.particles.release(p); }
  }
  for (let i = world.floatTexts.length - 1; i >= 0; i--) {
    const t = world.floatTexts[i];
    t.life -= dt; t.y += t.vy * dt;
    if (t.life <= 0) { world.floatTexts.splice(i, 1); world.fx.floatTexts.release(t); }
  }
}

export function inAttackRange(world, attacker, target) {
  const range = (attacker.stats?.attack_range ?? 0) + target.radius + attacker.radius;
  return dist2(attacker.x, attacker.y, target.x, target.y) <= range * range;
}

export { dist };
