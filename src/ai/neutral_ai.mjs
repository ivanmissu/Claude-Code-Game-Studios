/**
 * src/ai/neutral_ai.js — 中立野怪的牵引与返回（story-006）。
 *
 * .claude/rules/ai-code.md：参数全部数据驱动、可调试、有性能预算。
 * 规则：中立怪不主动攻击路过单位；被攻击后追击；目标死亡/超出牵引半径 →
 * 返回营地并按 leash.reset_heal_pct_per_sec 快速回满。
 */
import { dist2 } from '../core/math.mjs';
import { moveTowards } from '../gameplay/world.mjs';

export function updateNeutrals(world, dt) {
  const leash = world.data.jungle.leash;
  const ents = world.entities;
  for (let i = 0; i < ents.length; i++) {
    const n = ents[i];
    if (n.kind !== 'neutral' || !n.alive) continue;

    const homeD2 = dist2(n.x, n.y, n.homeX, n.homeY);
    const leashR2 = leash.radius * leash.radius;

    // 1) 目标有效性
    let target = n.aggroTargetId ? world.byId.get(n.aggroTargetId) : null;
    if (target && (!target.alive || target.team === 'neutral')) target = null;
    if (target && dist2(n.x, n.y, target.x, target.y) > leashR2) target = null;
    if (target && homeD2 > leashR2) target = null;      // 被风筝出牵引圈 → 放弃

    if (!target) {
      n.aggroTargetId = 0;
      n.targetId = 0;
      // 2) 返回营地并快速回血
      if (homeD2 > 16 * 16) {
        n.leashing = true;
        moveTowards(n, n.homeX, n.homeY, dt, n.stats.move_speed * leash.return_move_speed_pct);
      } else {
        n.leashing = false;
        n.x = n.homeX; n.y = n.homeY;
      }
      const heal = n.stats.max_health * leash.reset_heal_pct_per_sec * dt;
      n.health = Math.min(n.stats.max_health, n.health + heal);
      continue;
    }

    n.leashing = false;
    n.targetId = target.id;
    const range = n.stats.attack_range + target.radius + n.radius;
    if (dist2(n.x, n.y, target.x, target.y) > range * range) {
      moveTowards(n, target.x, target.y, dt);
    }
  }
}

/** 调试输出（ai-code.md 要求可调试性）。 */
export function debugNeutral(n) {
  return { id: n.id, type: n.typeId, leashing: n.leashing, target: n.aggroTargetId, hp: Math.round(n.health) };
}
