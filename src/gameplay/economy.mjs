/**
 * src/gameplay/economy.js — 金钱、经验、等级、技能点、装备、复活。
 *
 * story-005 的验收标准都在这里兑现。所有阈值/曲线读自
 * assets/data/economy_progression.json 与 economy_items.json，本文件不含平衡数字。
 */
import { dist2, clamp } from '../core/math.mjs';
import { EV } from '../core/events.mjs';
import { recalcHeroStats, removeEntity, TEAMS } from './world.mjs';
import { xpToNext, respawnTime, abilityCooldown } from './stats.mjs';
import { addBuff, removeBuff } from './buffs.mjs';

export function addGold(world, hero, amount, reason = '') {
  if (!hero || amount === 0) return;
  hero.gold += amount;
  if (amount > 0) hero.goldEarned += amount;
  world.teamState[hero.team].goldEarned += Math.max(0, amount);
  if (reason) world.events.emit('gold_changed', { heroId: hero.id, amount, reason });
}

/** 加经验并处理连续升级；返回升到的等级（未升级返回原等级）。 */
export function addXp(world, hero, amount) {
  if (!hero || amount <= 0) return hero?.level ?? 0;
  const prog = world.data.progression;
  hero.xp += amount;
  while (hero.level < prog.level_max && hero.xp >= xpToNext(prog, hero.level)) {
    hero.xp -= xpToNext(prog, hero.level);
    hero.level++;
    hero.skillPoints += prog.skill_points_per_level ?? 1;
    // recalcHeroStats 已按最大生命/法力变化比例保留当前百分比，此处不重复补偿
    recalcHeroStats(world.data, hero);
    world.events.emit(EV.LEVEL_GAINED, { heroId: hero.id, level: hero.level, team: hero.team });
  }
  if (hero.level >= prog.level_max) hero.xp = 0;
  return hero.level;
}

/** 经验分摊：以 (x,y) 为圆心、xp_radius 内的该阵营英雄平分（单人时即全额）。 */
export function shareXp(world, team, x, y, amount) {
  const radius = world.data.heroes.xp_radius;
  const r2 = radius * radius;
  // 只有存活英雄吃经验（死亡不获得附近经验；1v1 下这条规则简单且可测）
  const recipients = world.heroes.filter(h => h.team === team && h.alive && dist2(h.x, h.y, x, y) <= r2);
  if (!recipients.length) return recipients;
  const each = amount / recipients.length;
  for (const h of recipients) addXp(world, h, each);
  return recipients;
}

/** 末刀：金钱只给致命一击者，经验按范围分摊（story-002 验收标准）。 */
export function awardLastHit(world, victim, killer) {
  const gold = victim.bountyGold || 0;
  const xp = victim.bountyXp || 0;
  const killerTeam = killer?.team;
  if (killer && killer.kind === 'hero') {
    addGold(world, killer, gold, 'last_hit');
    killer.cs++;
    world.teamState[killer.team].cs++;
  } else if (killerTeam && killerTeam !== 'neutral') {
    // 小兵/塔击杀：金钱不发放（无末刀者），经验仍分摊给附近英雄
  }
  if (xp > 0 && killerTeam && killerTeam !== 'neutral') {
    shareXp(world, killerTeam, victim.x, victim.y, xp);
  } else if (xp > 0) {
    // 中立怪：经验给最后一击者所在阵营（打野的一方）
    const lastAttackerTeam = killer?.lastAttackerTeam;
    if (lastAttackerTeam) shareXp(world, lastAttackerTeam, victim.x, victim.y, xp);
  }
}

/** 英雄击杀：连杀加成与终结奖励（数据驱动）。 */
export function awardHeroKill(world, victim, killer) {
  const cfg = world.data.progression.hero_kill;
  victim.deaths++;
  victim.streak = 0;
  world.teamState[victim.team].deaths++;
  if (killer && killer.kind === 'hero' && killer.team !== victim.team) {
    killer.kills++;
    killer.streak++;
    world.teamState[killer.team].kills++;
    const streakBonus = cfg.streak_bonus_gold * Math.min(cfg.streak_bonus_max, Math.max(0, killer.streak - 1));
    const shutdown = victim.shutdownValue >= cfg.shutdown_gold ? victim.shutdownValue : 0;
    addGold(world, killer, cfg.base_gold + streakBonus + shutdown, 'hero_kill');
    victim.shutdownValue = 0;
    shareXp(world, killer.team, victim.x, victim.y, victim.def.kill_xp);
    world.events.emit(EV.HERO_KILLED, {
      killerId: killer.id, victimId: victim.id, killerTeam: killer.team,
      victimTeam: victim.team, byStructure: false
    });
  } else {
    world.events.emit(EV.HERO_KILLED, {
      killerId: killer?.id ?? 0, victimId: victim.id, killerTeam: killer?.team ?? 'none',
      victimTeam: victim.team, byStructure: killer?.kind === 'structure'
    });
  }
  // 被击杀者的终结价值随连杀累积（供对手领取）
  victim.respawnAt = world.time + respawnTime(world.data.progression, victim.level);
  victim.deathAt = world.time;
  victim.moveTarget = null;
  victim.targetId = 0;
}

/** 建筑奖励：最后一击者 + 全队分摊。 */
export function awardStructureBounty(world, structure, killer) {
  const b = structure.def.bounty || {};
  if (killer && killer.kind === 'hero' && b.killer_gold) addGold(world, killer, b.killer_gold, 'structure_kill');
  const enemyTeam = structure.team;
  for (const team of TEAMS) {
    if (team === enemyTeam) continue;
    const hero = world.heroByTeam[team];
    if (!hero) continue;
    if (b.team_gold) addGold(world, hero, b.team_gold, 'structure_team');
    if (b.team_xp) addXp(world, hero, b.team_xp);
    world.teamState[team].structuresDestroyed++;
  }
}

/* ---------------------------------------------------------------- 装备 */
export function canBuy(world, hero, itemId) {
  const item = world.data.items.items[itemId];
  if (!item) return { ok: false, reason: 'unknown_item' };
  if (!hero.alive) return { ok: false, reason: 'dead' };
  if (hero.items.length >= world.data.progression.item_slots) return { ok: false, reason: 'slots_full' };
  if (hero.gold < item.cost) return { ok: false, reason: 'cant_afford' };
  return { ok: true };
}

export function buyItem(world, hero, itemId) {
  const check = canBuy(world, hero, itemId);
  if (!check.ok) return check;
  const item = world.data.items.items[itemId];
  hero.items.push(itemId);
  addGold(world, hero, -item.cost, 'buy');
  recalcHeroStats(world.data, hero);
  world.events.emit(EV.ITEM_BOUGHT, { heroId: hero.id, itemId, cost: item.cost });
  return { ok: true, itemId };
}

export function sellItem(world, hero, slot) {
  const itemId = hero.items[slot];
  if (!itemId) return { ok: false, reason: 'empty_slot' };
  if (!hero.alive) return { ok: false, reason: 'dead' };
  const item = world.data.items.items[itemId];
  const value = Math.floor(item.cost * world.data.progression.sell_ratio);
  hero.items.splice(slot, 1);
  addGold(world, hero, value, 'sell');
  recalcHeroStats(world.data, hero);
  world.events.emit(EV.ITEM_SOLD, { heroId: hero.id, itemId, value });
  return { ok: true, itemId, value };
}

/* ---------------------------------------------------------------- 技能加点 */
export function canRankUp(world, hero, slot) {
  if (slot === 'passive') return { ok: false, reason: 'passive_auto' };
  const abilityId = hero.def.abilities[slot];
  const ability = world.data.abilities.abilities[abilityId];
  if (!ability) return { ok: false, reason: 'unknown_ability' };
  if (hero.skillPoints <= 0) return { ok: false, reason: 'no_points' };
  const cur = hero.skillLevels[slot] || 0;
  if (cur >= ability.rank_max) return { ok: false, reason: 'max_rank' };
  if (hero.level < (ability.required_level || 1) + cur * 5) {
    return { ok: false, reason: 'level_required' };
  }
  return { ok: true };
}

export function rankUpAbility(world, hero, slot) {
  const check = canRankUp(world, hero, slot);
  if (!check.ok) return check;
  hero.skillLevels[slot] = (hero.skillLevels[slot] || 0) + 1;
  hero.skillPoints--;
  world.events.emit(EV.ABILITY_RANKED_UP, { heroId: hero.id, slot, rank: hero.skillLevels[slot] });
  return { ok: true, rank: hero.skillLevels[slot] };
}

/* ---------------------------------------------------------------- 回复与复活 */
export function updateHeroResources(world, hero, dt) {
  if (!hero.alive) return;
  const s = hero.stats;
  hero.health = Math.min(s.max_health, hero.health + s.health_regen * dt);
  hero.mana = Math.min(s.max_mana, hero.mana + s.mana_regen * dt);
  // 泉水：范围内快速回复
  const f = world.data.map.fountain;
  const base = world.data.map.bases[hero.team].fountain;
  if (dist2(hero.x, hero.y, base[0], base[1]) <= f.radius * f.radius) {
    hero.health = Math.min(s.max_health, hero.health + s.max_health * f.heal_pct_per_sec * dt);
    hero.mana = Math.min(s.max_mana, hero.mana + s.max_mana * f.heal_pct_per_sec * dt);
    hero.inFountain = true;
  } else hero.inFountain = false;
}

export function updateRespawns(world) {
  for (const hero of world.heroes) {
    if (hero.alive || hero.respawnAt < 0 || world.time < hero.respawnAt) continue;
    respawnHero(world, hero);
  }
}

export function respawnHero(world, hero) {
  const base = world.data.map.bases[hero.team].fountain;
  hero.alive = true;
  hero.x = base[0]; hero.y = base[1];
  hero.health = hero.stats.max_health;
  hero.mana = hero.stats.max_mana;
  hero.shield = 0;
  hero.respawnAt = -1;
  hero.moveTarget = null;
  hero.targetId = 0;
  hero.attackCooldown = 0;
  hero.windup = 0;
  for (const k in hero.cooldowns) hero.cooldowns[k] = 0;
  // 复活不清除 team_wide 的增益（大龙 buff），只清 lost_on_death 的（已在死亡时清）
  world.events.emit('hero_respawned', { heroId: hero.id, team: hero.team });
}

/** 被动收入：每秒固定金钱（数据驱动）。 */
export function updatePassiveGold(world, dt) {
  const g = world.data.progression.passive_gold_per_sec * dt;
  for (const hero of world.heroes) addGold(world, hero, g, 'passive');
}

/** 冷却推进（应用冷却缩减）。 */
export function updateCooldowns(world, hero, dt) {
  for (const slot of ['q', 'w', 'e', 'r']) {
    if (hero.cooldowns[slot] > 0) hero.cooldowns[slot] = Math.max(0, hero.cooldowns[slot] - dt);
  }
}

export function startCooldown(world, hero, slot, rank) {
  const ability = world.data.abilities.abilities[hero.def.abilities[slot]];
  hero.cooldowns[slot] = abilityCooldown(ability, rank, hero.stats);
}
