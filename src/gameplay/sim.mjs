/**
 * src/gameplay/sim.js — 模拟编排（固定步长、确定性）。
 *
 * 这是 gameplay 层的顶层：只依赖 core/gameplay/ai，不 import DOM、render、ui
 * （.claude/rules/gameplay-code.md）。因此浏览器与 Node 跑的是同一份模拟：
 * `tools/smoke.mjs`、`tests/` 与 `tools/render_evidence.mjs` 都直接驱动它。
 *
 * 输入模型：每个受控英雄每 tick 收到一份 input_state（玩家来自 ui，AI 来自 ai/hero_ai）。
 * AI 与玩家共用这条接口，是 story-004 的验收标准之一。
 */
import { dist, dist2, clamp, pointAtDistance, distanceAlongPath } from '../core/math.mjs';
import { moveTowards, clampToWorld, advanceAlongLane, rebuildGrid, queryNear, FIXED_DT, TEAMS } from './world.mjs';
import { recalcHeroStats } from './world.mjs';
import { tickBuffs } from './buffs.mjs';
import { castAbility, updateDashes } from './abilities.mjs';
import { updateCombat, updateProjectiles, updateEffects, updateParticles, inAttackRange } from './combat.mjs';
import { updateNeutrals } from '../ai/neutral_ai.mjs';
import { updateWaves, updateCamps, refreshInvulnerability, checkVictory } from './objectives.mjs';
import {
  updateHeroResources, updateRespawns, updatePassiveGold, updateCooldowns,
  buyItem, sellItem, rankUpAbility
} from './economy.mjs';

const NEAR = [];
const EXPIRED = [];
const LEASH_ANCHOR = { x: 0, y: 0, dx: 0, dy: 0 };   // 复用的锚点出参（core 层约定：热路径零分配）

export function createInputState() {
  return { move: null, attackMove: null, attackTarget: 0, casts: [], buy: null, sell: -1, rankUp: null };
}

/** 每 tick 推进一次。dt 必须是固定步长（FIXED_DT），否则确定性不成立。 */
export function tick(world, inputs, dt = FIXED_DT) {
  if (world.over) { world.events.flush(); return world; }
  world.dt = dt;
  world.time += dt;
  world.tickCount++;

  // 1) buff 生命周期 → 属性重算（必须在战斗前，否则本 tick 用的是过期属性）
  for (const hero of world.heroes) {
    if (tickBuffs(hero.buffs, world.time, EXPIRED).length) hero.statsDirty = true;
    if (hero.statsDirty) recalcHeroStats(world.data, hero);
    hero.health = clamp(hero.health, 0, hero.stats.max_health);
    hero.mana = clamp(hero.mana, 0, hero.stats.max_mana);
  }
  for (const e of world.entities) {
    if (e.kind === 'hero' || !e.buffs) continue;
    if (tickBuffs(e.buffs, world.time, EXPIRED).length && e.stats) {
      // 小兵的减速影响移速
      let ms = e.stats.move_speed;
      for (const b of e.buffs.list) ms *= 1 + (b.modifiers?.pct?.move_speed_pct || 0);
      e.moveSpeed = Math.max(40, ms);
    }
  }

  // 2) 输入 → 命令
  for (const team of TEAMS) {
    const hero = world.heroByTeam[team];
    if (hero) applyInput(world, hero, inputs?.[team]);
  }

  // 3) 位移
  updateDashes(world, dt);
  for (const e of world.entities) {
    if (!e.alive) continue;
    if (e.kind === 'hero') updateHeroMovement(world, e, dt);
    else if (e.kind === 'minion') updateMinionMovement(world, e, dt);
  }
  updateNeutrals(world, dt);

  // 4) 战斗
  updateCombat(world, dt);
  updateProjectiles(world, dt);
  updateEffects(world, dt);

  // 5) 目标与波次
  updateWaves(world, dt);
  updateCamps(world);
  refreshInvulnerability(world);

  // 6) 经济
  updatePassiveGold(world, dt);
  for (const hero of world.heroes) {
    updateHeroResources(world, hero, dt);
    updateCooldowns(world, hero, dt);
  }
  updateRespawns(world);

  // 7) 表现状态（粒子存活在模拟里，使无头渲染与浏览器渲染同一帧）
  updateParticles(world, dt);

  // 8) 收尾
  for (const e of world.entities) if (e.alive) clampToWorld(world, e);
  rebuildGrid(world);
  checkVictory(world);
  world.events.flush();
  return world;
}

/* ---------------------------------------------------------------- 输入 */
export function applyInput(world, hero, input) {
  if (!input || !hero.alive || world.over) return;
  if (input.rankUp) {
    const r = rankUpAbility(world, hero, input.rankUp);
    if (!r.ok) world.events.emit('command_failed', { heroId: hero.id, command: 'rankUp', slot: input.rankUp, reason: r.reason });
  }
  if (input.buy) {
    const r = buyItem(world, hero, input.buy);
    if (!r.ok) world.events.emit('command_failed', { heroId: hero.id, command: 'buy', itemId: input.buy, reason: r.reason });
  }
  if (input.sell >= 0) {
    const r = sellItem(world, hero, input.sell);
    if (!r.ok) world.events.emit('command_failed', { heroId: hero.id, command: 'sell', slot: input.sell, reason: r.reason });
  }
  if (input.casts?.length) {
    for (const c of input.casts) {
      const aim = { x: c.x ?? hero.x, y: c.y ?? hero.y, targetId: c.targetId ?? 0 };
      // 单体技能没有显式目标时，取射程内最近的敌方英雄
      if (!aim.targetId) {
        const ab = world.data.abilities.abilities[hero.def.abilities[c.slot]];
        if (ab?.targeting === 'unit') aim.targetId = nearestEnemyHeroId(world, hero, ab.range || 700);
      }
      const res = castAbility(world, hero, c.slot, aim);
      if (!res.ok) world.events.emit('cast_failed', { heroId: hero.id, slot: c.slot, reason: res.reason });
    }
  }
  if (input.attackTarget) {
    const t = world.byId.get(input.attackTarget);
    if (t && t.alive) { hero.targetId = t.id; hero.moveTarget = null; hero.attackMoveTarget = null; }
  }
  if (input.attackMove) {
    hero.attackMoveTarget = { x: input.attackMove.x, y: input.attackMove.y };
    hero.moveTarget = null; hero.targetId = 0;
  }
  if (input.move) {
    hero.moveTarget = { x: input.move.x, y: input.move.y };
    hero.attackMoveTarget = null; hero.targetId = 0;
  }
  if (input.stop) { hero.moveTarget = null; hero.attackMoveTarget = null; hero.targetId = 0; }
}

function nearestEnemyHeroId(world, hero, radius) {
  queryNear(world, hero.x, hero.y, radius, NEAR, 'hero');
  let best = 0, bestD = Infinity;
  for (const t of NEAR) {
    if (t.team === hero.team || !t.alive) continue;
    const d = dist2(hero.x, hero.y, t.x, t.y);
    if (d < bestD) { bestD = d; best = t.id; }
  }
  return best;
}

function updateHeroMovement(world, hero, dt) {
  const cfg = world.data.heroes.hero_combat;
  const target = hero.targetId ? world.byId.get(hero.targetId) : null;
  if (target && target.alive) {
    if (inAttackRange(world, hero, target)) { hero.moveTarget = null; return; }
    if (dist2(hero.x, hero.y, target.x, target.y) > cfg.chase_giveup_radius ** 2) { hero.targetId = 0; return; }
    moveTowards(hero, target.x, target.y, dt);
    return;
  }
  hero.targetId = 0;

  if (hero.attackMoveTarget) {
    // 攻击移动：途中发现敌人就停下攻击（story-001 验收标准）
    const acquired = acquireAttackMoveTarget(world, hero, cfg.attack_move_acquire_radius);
    if (acquired) { hero.targetId = acquired.id; return; }
    if (moveTowards(hero, hero.attackMoveTarget.x, hero.attackMoveTarget.y, dt) === false) {
      hero.attackMoveTarget = null;
    }
    return;
  }
  if (hero.moveTarget) {
    if (moveTowards(hero, hero.moveTarget.x, hero.moveTarget.y, dt) === false) hero.moveTarget = null;
  }
}

function acquireAttackMoveTarget(world, hero, radius) {
  queryNear(world, hero.x, hero.y, radius, NEAR);
  let best = null, bestD = Infinity;
  for (const t of NEAR) {
    if (!t.alive || t.team === hero.team || t.team === 'neutral') continue;
    if (t.kind === 'structure' && t.invulnerable) continue;
    const d = dist2(hero.x, hero.y, t.x, t.y);
    // 英雄优先于小兵：攻击移动时更贴近玩家意图
    const bias = t.kind === 'hero' ? 0.72 : 1;
    if (d * bias < bestD) { bestD = d * bias; best = t; }
  }
  return best;
}

/**
 * 小兵移动：有车路锚点（laneDist），索敌后可短暂离开车路追击。
 *
 * 这里曾经有一个让整局打不完的 bug，修复过程记录在此，避免重犯：
 *   1. 拉扯判定用的是「小兵↔目标」距离而不是「小兵↔车路锚点」距离，且 leash_radius 高达 900，
 *      于是小兵会被拖着横穿半张地图；
 *   2. 追击期间 laneDist 只做 clamp（等于没更新），放弃目标后 advanceAlongLane 按**旧锚点**
 *      取点，把小兵瞬移回追击前的位置；
 *   3. 回弹后目标仍在 acquire_radius 内，立刻重新仇恨 → 无限抖动，净位移为零。
 * 实测症状：双方兵线永远停在中路两侧约 500 单位处互不接触，塔只被磨掉一层皮，一局 25 分钟推不完。
 * 修法：锚点固定为索敌时的 laneDist，拉扯距离按「离锚点多远」判定；一旦放弃追击或目标死亡，
 * 把 laneDist 重新投影到**真实位置**（不回弹），并给一小段不再索敌的冷却，保证净推进为正。
 */
function updateMinionMovement(world, m, dt) {
  const aggro = world.data.minions.aggro;
  if (m.leashCd > 0) m.leashCd -= dt;
  if (m.targetId) {
    const t = world.byId.get(m.targetId);
    if (t && t.alive) {
      const range = m.stats.attack_range + t.radius + m.radius;
      if (dist2(m.x, m.y, t.x, t.y) <= range * range) return;   // 已在射程内，交给 combat 处理
      pointAtDistance(world.lanePath, m.laneDist, LEASH_ANCHOR);
      const stray = dist(m.x, m.y, LEASH_ANCHOR.x, LEASH_ANCHOR.y);
      if (stray > aggro.leash_radius || m.leashCd > 0) {
        m.targetId = 0;
        m.leashCd = aggro.leash_cooldown_sec ?? 0.5;
        // 不回弹：从当前真实位置继续推进，否则净位移为零
        m.laneDist = distanceAlongPath(world.lanePath, m.x, m.y);
      } else {
        moveTowards(m, t.x, t.y, dt);
      }
      return;
    }
    m.targetId = 0;
    m.laneDist = distanceAlongPath(world.lanePath, m.x, m.y);
  }
  advanceAlongLane(world, m, dt);
}

/** 无头/测试用的多 tick 推进。 */
export function runTicks(world, count, inputsProvider, dt = FIXED_DT) {
  for (let i = 0; i < count && !world.over; i++) {
    const inputs = inputsProvider ? inputsProvider(world, i) : null;
    tick(world, inputs, dt);
  }
  return world;
}
