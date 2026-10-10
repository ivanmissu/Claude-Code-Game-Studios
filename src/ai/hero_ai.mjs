/**
 * src/ai/hero_ai.js — 敌方英雄 AI（story-004）。
 *
 * 关键约束（story-004 验收标准）：AI **只产出 input_state**，与玩家走完全相同的
 * 输入接口，绝不直接改实体状态 —— 这既保证公平，也让 AI 可被回放输入替换。
 *
 * .claude/rules/ai-code.md：参数全部来自 assets/data/ai_hero.json；带反应延迟与
 * 失误率（不得有超人反应）；带性能预算与可调试输出。
 */
import { dist, dist2, clamp, pointAtDistance } from '../core/math.mjs';
import { queryNear, laneDistanceOf, getEntity } from '../gameplay/world.mjs';
import { abilityOf } from '../gameplay/abilities.mjs';
import { abilityCost } from '../gameplay/stats.mjs';
import { canBuy, canRankUp } from '../gameplay/economy.mjs';

const NEAR = [];
const AIM = { x: 0, y: 0 };
const PATH_OUT = { x: 0, y: 0, dx: 0, dy: 0 };

export function emptyInput() {
  return { move: null, attackMove: null, attackTarget: 0, casts: [], buy: null, sell: -1, rankUp: null };
}

/**
 * AI 控制器：持有决策计时与状态（不写世界状态）。
 */
export function createHeroAi(world, hero, aiData) {
  return {
    hero, ai: aiData,
    state: 'farm', reason: 'init',
    nextDecisionAt: 0,
    pending: null,          // 反应延迟队列
    pendingAt: 0,
    budgetWarned: 0,
    lastScanCount: 0
  };
}

export function updateHeroAi(world, ctrl, dt) {
  const hero = ctrl.hero;
  if (!hero.alive) return emptyInput();
  const input = emptyInput();

  // 反应延迟：到点才提交上一次决策的结果
  if (ctrl.pending && world.time >= ctrl.pendingAt) {
    Object.assign(input, ctrl.pending);
    ctrl.pending = null;
  }

  // 加点与购买不需要走反应延迟（不影响操作公平性），每次都尝试
  applySkillLevels(world, hero, ctrl.ai, input);
  applyItemBuild(world, hero, ctrl.ai, input);

  // 上一次决策还没提交时不再决策：否则 decision_interval_sec < input_delay_sec
  // 会让待提交的决策被不断覆盖、永远消费不掉（AI 表现为"完全不动"）。
  if (ctrl.pending || world.time < ctrl.nextDecisionAt) return input;

  const t0 = nowUs();
  const decision = decide(world, hero, ctrl);
  const cost = nowUs() - t0;
  ctrl.decisions = (ctrl.decisions || 0) + 1;
  // 预热窗口内的决策不计入性能告警（见 ai_hero.json → budget._doc）
  if (ctrl.decisions > (ctrl.ai.budget.warmup_decisions || 0) && cost > ctrl.ai.budget.warn_us_per_tick) {
    ctrl.budgetWarned++;
    ctrl.worstUs = Math.max(ctrl.worstUs || 0, cost);
    if (ctrl.budgetWarned <= 3) {
      console.warn(`[ai] decision took ${cost.toFixed(0)}µs > budget ${ctrl.ai.budget.warn_us_per_tick}µs (state=${ctrl.state})`);
    }
  }
  ctrl.pending = decision;
  ctrl.pendingAt = world.time + ctrl.ai.reaction.input_delay_sec;
  ctrl.nextDecisionAt = ctrl.pendingAt + ctrl.ai.reaction.decision_interval_sec;
  return input;
}

function nowUs() {
  const hr = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  return hr * 1000;
}

/* ---------------------------------------------------------------- 决策 */
function decide(world, hero, ctrl) {
  const ai = ctrl.ai;
  const enemy = world.heroes.find(h => h.team !== hero.team);
  const hpPct = hero.health / hero.stats.max_health;
  const base = world.data.map.bases[hero.team];
  const fountain = { x: base.fountain[0], y: base.fountain[1] };

  // 1) 撤退
  const retreat = ai.states.retreat;
  if (ctrl.state === 'retreat' ? hpPct < retreat.exit_hp_pct : hpPct < retreat.enter_hp_pct) {
    ctrl.state = 'retreat'; ctrl.reason = `hp ${(hpPct * 100).toFixed(0)}% < retreat threshold`;
    const out = emptyInput();
    out.move = { x: fountain.x, y: fountain.y };
    // 撤退途中仍可用护盾/位移自救
    const self = pickSelfSaveAbility(world, hero);
    if (self && enemy && dist(hero.x, hero.y, enemy.x, enemy.y) < 500) out.casts.push({ slot: self, x: hero.x, y: hero.y, targetId: 0 });
    return out;
  }
  // 2) 泉水回复（撤退状态的自然延续）
  if (dist2(hero.x, hero.y, fountain.x, fountain.y) < 300 * 300 && hpPct < 0.97) {
    ctrl.state = 'recall'; ctrl.reason = 'healing in fountain';
    const out = emptyInput();
    out.move = { x: fountain.x, y: fountain.y };
    return out;
  }

  // 3) 回防：己方建筑被攻击或血量告急
  const defend = findDefendTarget(world, hero, ai);
  if (defend) {
    ctrl.state = 'defend'; ctrl.reason = `allied ${defend.structure.structureKind} under attack`;
    return combatInput(world, hero, ctrl, enemy, defend.attacker || lanePointAhead(world, hero, -260));
  }

  const push = ai.states.push;
  // 4a) 收割窗口：敌方英雄残血 ⇒ 追着打（制造死亡，才有后续推进窗口）
  const commit = push.commit_kill;
  if (commit && enemy && enemy.alive
      && (enemy.health / enemy.stats.max_health) < commit.enemy_hp_pct_below
      && hpPct >= commit.self_hp_pct_above
      && dist(hero.x, hero.y, enemy.x, enemy.y) < commit.chase_radius
      && !(commit.avoid_enemy_tower && underEnemyTower(world, hero, enemy))) {
    ctrl.state = 'commit';
    ctrl.reason = `enemy hp ${((enemy.health / enemy.stats.max_health) * 100).toFixed(0)}% → commit kill`;
    const out = combatInput(world, hero, ctrl, enemy, enemy);
    out.attackTarget = enemy.id;
    out.move = { x: enemy.x, y: enemy.y };
    return out;
  }

  // 4b) 惩罚窗口：敌方英雄死亡 ⇒ 无视兵线掩护直接推塔（MOBA 里最重要的推进时机）
  if (push.punish_enemy_dead && enemy && !enemy.alive && hpPct >= push.punish_min_hp_pct) {
    const target = findVulnerableEnemyStructure(world, hero);
    if (target) {
      ctrl.state = 'push';
      ctrl.reason = `enemy hero dead (${Math.max(0, enemy.respawnAt - world.time).toFixed(0)}s respawn) → punish push`;
      const out = combatInput(world, hero, ctrl, null, null);
      out.attackTarget = target.id;
      if (dist(hero.x, hero.y, target.x, target.y) > hero.stats.attack_range + target.radius) {
        out.move = { x: target.x, y: target.y };
      }
      return out;
    }
  }

  // 4c) 压塔：己方兵线已到敌方塔下，或该区域敌方兵线已被清空且自身足够健康
  if (hpPct >= push.min_hp_pct) {
    const target = findVulnerableEnemyStructure(world, hero);
    const cover = target && allyMinionsNear(world, hero.team, target, push.require_ally_minions_near_structure);
    const laneCleared = target && hpPct >= push.push_min_hp_pct_no_cover
      && !enemyMinionsNear(world, hero.team, target, push.push_when_lane_cleared_within);
    if (target && (cover || laneCleared)) {
      ctrl.state = 'push'; ctrl.reason = `pushing ${target.structureKind} with minion cover`;
      const out = combatInput(world, hero, ctrl, enemy, null);
      out.attackTarget = target.id;
      if (dist(hero.x, hero.y, target.x, target.y) > hero.stats.attack_range + target.radius) {
        out.move = { x: target.x, y: target.y };
      }
      return out;
    }
  }

  // 4d) 清线推进：敌方英雄不在威胁范围内 ⇒ 主动清兵，把兵线推进塔下（打破中路僵局）
  const laneClear = ai.states.farm.lane_clear;
  if (laneClear && laneClear.enabled && hpPct >= laneClear.self_hp_pct_above) {
    const enemyHeroNear = enemy && enemy.alive
      && dist(hero.x, hero.y, enemy.x, enemy.y) < laneClear.when_no_enemy_hero_within;
    if (!enemyHeroNear) {
      const m = nearestEnemyMinion(world, hero, laneClear.search_radius);
      if (m) {
        ctrl.state = 'lane_clear';
        ctrl.reason = 'clearing wave → push lane';
        const out = combatInput(world, hero, ctrl, enemy, m);
        out.attackTarget = m.id;
        if (!inRange(hero, m)) out.move = { x: m.x, y: m.y };
        return out;
      }
    }
  }

  // 5) 野区机会
  const camp = findJungleOpportunity(world, hero, ai, hpPct);
  if (camp) {
    ctrl.state = 'jungle'; ctrl.reason = `clearing ${camp.id}`;
    const unit = getEntity(world, camp.units[0]);
    const out = combatInput(world, hero, ctrl, enemy, null);
    if (unit) { out.attackTarget = unit.id; out.move = { x: unit.x, y: unit.y }; }
    return out;
  }

  // 6) 对线：补刀 + 消耗
  const out = combatInput(world, hero, ctrl, enemy, null);
  const lastHit = findLastHitTarget(world, hero, ai);
  if (lastHit) {
    ctrl.state = 'farm'; ctrl.reason = `last hit ${lastHit.typeId} @${Math.round(lastHit.health)}hp`;
    out.attackTarget = lastHit.id;
    if (!inRange(hero, lastHit)) out.move = { x: lastHit.x, y: lastHit.y };
    return out;
  }
  // 保持对线距离：站到己方小兵后方、敌方英雄射程外的位置
  const hold = laneHoldPoint(world, hero, ai);
  ctrl.state = 'harass'; ctrl.reason = enemy && out.casts.length ? 'casting at enemy hero' : 'holding lane position';
  if (!out.casts.length) { out.move = hold; }
  else { out.move = null; }
  return out;
}

/** 通用战斗输入：选技能、瞄准、必要时攻击敌方英雄。 */
function combatInput(world, hero, ctrl, enemy, forcedTarget) {
  const ai = ctrl.ai;
  const out = emptyInput();
  const harass = ai.states.harass;
  if (forcedTarget && forcedTarget.alive) {
    out.attackTarget = forcedTarget.id;
    if (!inRange(hero, forcedTarget)) out.move = { x: forcedTarget.x, y: forcedTarget.y };
  }
  if (!enemy || !enemy.alive) return out;
  const manaPct = hero.mana / Math.max(1, hero.stats.max_mana);
  if (manaPct < harass.min_mana_pct) return out;
  const d = dist(hero.x, hero.y, enemy.x, enemy.y);

  // 终极技：敌方血量不高或在射程内时开
  const r = abilityOf(world, hero, 'r');
  if (r && (hero.skillLevels.r || 0) > 0 && (hero.cooldowns.r || 0) <= 0) {
    const rRange = r.range || hero.stats.attack_range + 200;
    if (d < rRange && (enemy.health / enemy.stats.max_health) < 0.72) {
      out.casts.push({ slot: 'r', x: hero.x, y: hero.y, targetId: 0 });
    }
  }
  // 自保技能（护盾/位移）：血量偏低或敌人贴近
  const save = pickSelfSaveAbility(world, hero);
  if (save && d < 460 && hero.health / hero.stats.max_health < 0.62) {
    out.casts.push({ slot: save, x: enemy.x, y: enemy.y, targetId: 0 });
  }
  // 主要消耗技能：q（单体/直线）与 e（范围）
  for (const slot of ['q', 'e']) {
    const ab = abilityOf(world, hero, slot);
    if (!ab) continue;
    const rank = hero.skillLevels[slot] || 0;
    if (rank <= 0 || (hero.cooldowns[slot] || 0) > harass.cooldown_gap_sec) continue;
    if (hero.mana < abilityCost(ab, rank)) continue;
    const range = (ab.range || 0) * harass.cast_range_pct;
    if (d > range) continue;
    if ((enemy.health / enemy.stats.max_health) > harass.max_enemy_hp_pct && slot === 'e') continue;
    const aim = predictAim(world, hero, enemy, ab, ai);
    out.casts.push({
      slot, x: aim.x, y: aim.y,
      targetId: ab.targeting === 'unit' ? enemy.id : 0
    });
    break;                       // 一次决策只放一个主要技能，避免瞬间倾泻
  }
  return out;
}

function pickSelfSaveAbility(world, hero) {
  for (const slot of ['w']) {
    const ab = abilityOf(world, hero, slot);
    if (!ab) continue;
    if ((hero.skillLevels[slot] || 0) <= 0) continue;
    if ((hero.cooldowns[slot] || 0) > 0) continue;
    if (ab.kind === 'shield' || ab.kind === 'dash') return slot;
  }
  return null;
}

/** 预测瞄准：按目标移动方向做提前量，再叠加 AI 的瞄准误差与失误率。 */
function predictAim(world, hero, target, ability, ai) {
  const speed = ability.speed || 900;
  const travel = dist(hero.x, hero.y, target.x, target.y) / speed;
  let vx = 0, vy = 0;
  const mt = target.moveTarget;
  if (mt) {
    const d = dist(target.x, target.y, mt.x, mt.y) || 1;
    const ms = target.stats?.move_speed ?? 0;
    vx = ((mt.x - target.x) / d) * ms;
    vy = ((mt.y - target.y) / d) * ms;
  }
  let ax = target.x + vx * travel;
  let ay = target.y + vy * travel;
  // 失误率：一定概率大幅偏瞄（打空）
  const err = world.rng.chance(ai.reaction.miss_chance_pct) ? 34 : ai.reaction.aim_error_deg;
  const rad = (err * Math.PI) / 180 * (world.rng.next() < 0.5 ? -1 : 1);
  const dx = ax - hero.x, dy = ay - hero.y;
  const len = Math.hypot(dx, dy) || 1;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  AIM.x = hero.x + (dx * cos - dy * sin);
  AIM.y = hero.y + (dx * sin + dy * cos);
  return AIM;
}

function inRange(hero, target) {
  const r = hero.stats.attack_range + target.radius + hero.radius;
  return dist2(hero.x, hero.y, target.x, target.y) <= r * r;
}

/** 补刀判定：能被我们这一下打死的小兵（含护甲减免与时间误差）。 */
function findLastHitTarget(world, hero, ai) {
  queryNear(world, hero.x, hero.y, hero.stats.attack_range + 340, NEAR, 'minion');
  const scan = Math.min(NEAR.length, ai.budget.max_target_scan_per_tick);
  let best = null, bestScore = Infinity;
  const dmg = hero.stats.attack_damage * (100 / (100 + 8));   // 用敌方小兵典型护甲近似
  const tolerance = dmg * (1 - ai.reaction.last_hit_timing_error_pct);
  for (let i = 0; i < scan; i++) {
    const m = NEAR[i];
    if (m.team === hero.team || !m.alive) continue;
    if (m.health > tolerance) continue;
    // 敌方塔下的小兵不冒险去补（除非血量健康）
    if (underEnemyTower(world, hero, m) && hero.health / hero.stats.max_health < 0.6) continue;
    const score = dist2(hero.x, hero.y, m.x, m.y);
    if (score < bestScore) { bestScore = score; best = m; }
  }
  return best;
}

function underEnemyTower(world, hero, point) {
  for (const e of world.entities) {
    if (e.kind !== 'structure' || e.team === hero.team || !e.alive || e.invulnerable) continue;
    if (dist2(e.x, e.y, point.x, point.y) < (e.stats.attack_range * 0.92) ** 2) return true;
  }
  return false;
}

/** 最近的敌方小兵（清线用）。 */
function nearestEnemyMinion(world, hero, radius) {
  queryNear(world, hero.x, hero.y, radius, NEAR, 'minion');
  let best = null, bd = Infinity;
  for (let i = 0; i < NEAR.length; i++) {
    const m = NEAR[i];
    if (m.team === hero.team || !m.alive) continue;
    const d = dist2(hero.x, hero.y, m.x, m.y);
    if (d < bd) { bd = d; best = m; }
  }
  return best;
}

function enemyMinionsNear(world, team, point, radius) {
  queryNear(world, point.x, point.y, radius, NEAR, 'minion');
  for (let i = 0; i < NEAR.length; i++) if (NEAR[i].team !== team && NEAR[i].alive) return true;
  return false;
}

function findVulnerableEnemyStructure(world, hero) {
  let best = null, bestD = Infinity;
  for (const e of world.entities) {
    if (e.kind !== 'structure' || e.team === hero.team || !e.alive || e.invulnerable) continue;
    const d = dist2(hero.x, hero.y, e.x, e.y);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

function allyMinionsNear(world, team, structure, radius) {
  queryNear(world, structure.x, structure.y, radius, NEAR, 'minion');
  for (let i = 0; i < NEAR.length; i++) if (NEAR[i].team === team) return true;
  return false;
}

function findDefendTarget(world, hero, ai) {
  const alert = ai.states.defend.structure_hp_pct_alert;
  for (const e of world.entities) {
    if (e.kind !== 'structure' || e.team !== hero.team || !e.alive) continue;
    const threatened = (e.health / e.stats.max_health) < alert || isBeingAttacked(world, e);
    if (!threatened) continue;
    // 找出正在打它的敌方英雄
    let atk = null;
    for (const h of world.heroes) {
      if (h.team === hero.team || !h.alive) continue;
      if (h.targetId === e.id || dist(h.x, h.y, e.x, e.y) < ai.states.defend.recall_radius) { atk = h; break; }
    }
    return { structure: e, attacker: atk };
  }
  return null;
}

function isBeingAttacked(world, structure) {
  for (const e of world.entities) {
    if (!e.alive || e.team === structure.team) continue;
    if (e.targetId === structure.id && e.kind === 'hero') return true;
  }
  return false;
}

function findJungleOpportunity(world, hero, ai, hpPct) {
  const j = ai.states.jungle;
  if (!j.enabled || hero.level < j.min_level || hpPct < j.min_hp_pct) return null;
  // 兵线在附近时不打野（对线优先）
  queryNear(world, hero.x, hero.y, j.skip_if_lane_minions_alive_within, NEAR, 'minion');
  for (let i = 0; i < NEAR.length; i++) if (NEAR[i].team !== hero.team) return null;
  let best = null, bestD = Infinity;
  for (const camp of Object.values(world.camps)) {
    if (camp.state !== 'alive' || !camp.units.length) continue;
    const pos = world.data.map.jungle_camps[camp.id];
    if (!pos) continue;
    const d = dist(hero.x, hero.y, pos[0], pos[1]);
    if (d > j.max_walk_units) continue;
    if (d < bestD) { bestD = d; best = camp; }
  }
  return best;
}

/** 对线站位：己方小兵群后方一点，且在敌方英雄射程外。 */
function laneHoldPoint(world, hero, ai) {
  const enemy = world.heroes.find(h => h.team !== hero.team);
  // 找到最靠前的己方小兵
  let front = null, frontD = hero.team === 'radiant' ? -Infinity : Infinity;
  for (const e of world.entities) {
    if (e.kind !== 'minion' || e.team !== hero.team || !e.alive) continue;
    const d = laneDistanceOf(world, e.x, e.y);
    if (hero.team === 'radiant' ? d > frontD : d < frontD) { frontD = d; front = e; }
  }
  const anchor = front ? laneDistanceOf(world, front.x, front.y) : laneDistanceOf(world, hero.x, hero.y);
  const back = hero.team === 'radiant' ? anchor - 150 : anchor + 150;
  pointAtDistance(world.lanePath, clamp(back, 0, world.lanePath.length), PATH_OUT);
  let x = PATH_OUT.x, y = PATH_OUT.y;
  // 与敌方英雄保持距离（若其更近则后退）
  if (enemy && enemy.alive) {
    const d = dist(x, y, enemy.x, enemy.y);
    const want = Math.max(hero.stats.attack_range * 0.8, 300);
    if (d < want) {
      const k = (want - d) / (d || 1);
      x += (x - enemy.x) * k;
      y += (y - enemy.y) * k;
    }
  }
  return { x, y };
}

function lanePointAhead(world, hero, offset) {
  const d = clamp(laneDistanceOf(world, hero.x, hero.y) + offset, 0, world.lanePath.length);
  pointAtDistance(world.lanePath, d, PATH_OUT);
  return { x: PATH_OUT.x, y: PATH_OUT.y };
}

/* ---------------------------------------------------------------- 成长 */
function applySkillLevels(world, hero, ai, input) {
  if (hero.skillPoints <= 0) return;
  const sl = ai.skill_levels;
  // 终极技只在指定等级点
  for (const lvl of sl.take_r_at_levels) {
    if (hero.level >= lvl && canRankUp(world, hero, 'r').ok) { input.rankUp = 'r'; return; }
  }
  for (const slot of sl.priority) {
    if (slot === 'r') continue;
    if (canRankUp(world, hero, slot).ok) { input.rankUp = slot; return; }
  }
}

function applyItemBuild(world, hero, ai, input) {
  const route = ai.item_build.route;
  const owned = hero.items;
  for (const id of route) {
    if (owned.includes(id)) continue;
    const item = world.data.items.items[id];
    if (!item) continue;
    if (hero.gold >= item.cost * ai.item_build.buy_when_gold_pct_of_cost && canBuy(world, hero, id).ok) {
      input.buy = id;
      return;
    }
    break;                       // 按路线顺序，买不起就等
  }
}

/** 可调试性（ai-code.md）：状态机当前状态与理由。 */
export function debugAi(ctrl, world) {
  return {
    state: ctrl.state,
    reason: ctrl.reason,
    nextDecisionIn: world ? +Math.max(0, ctrl.nextDecisionAt - world.time).toFixed(2) : null,
    pending: !!ctrl.pending,
    budgetWarnings: ctrl.budgetWarned
  };
}
