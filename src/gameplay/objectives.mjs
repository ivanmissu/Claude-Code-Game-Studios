/**
 * src/gameplay/objectives.js — 兵线波次、建筑无敌解锁、野怪营地、胜负判定。
 *
 * story-002 / story-003 / story-006 的验收标准在此兑现。
 * 胜负判定只依赖模拟状态（不看渲染、不碰 DOM），所以 tools/smoke.mjs 能无头验证。
 */
import { dist2, clamp } from '../core/math.mjs';
import { EV } from '../core/events.mjs';
import { addEntity, createMinion, createNeutral, removeEntity, TEAMS, laneDistanceOf } from './world.mjs';
import { addBuff, modifiersFromJungleBuff } from './buffs.mjs';
import { addGold, addXp } from './economy.mjs';

/* ---------------------------------------------------------------- 兵线 */
export function updateWaves(world, dt) {
  const wave = world.data.minions.wave;
  for (const team of TEAMS) {
    const st = world.waves[team];
    // 出兵队列（波内错开生成）
    for (let i = st.pending.length - 1; i >= 0; i--) {
      const p = st.pending[i];
      if (world.time < p.at) continue;
      st.pending.splice(i, 1);
      spawnMinion(world, team, p.typeId, p.index);
    }
    if (world.time >= st.nextAt) {
      st.count++;
      // 决胜期缩短出兵间隔（下限由数据给出），常规阶段用固定间隔
      const lg = world.data.minions.late_game_pressure;
      const step = pressureStep(world);
      const interval = step > 0 && lg
        ? Math.max(lg.min_wave_interval_sec, wave.wave_interval_sec * Math.pow(lg.wave_interval_mult_per_step, step))
        : wave.wave_interval_sec;
      st.nextAt += interval;
      queueWave(world, team, st.count);
    }
  }
}

function queueWave(world, team, waveIndex) {
  const cfg = world.data.minions.wave;
  const esc = world.data.minions.wave_escalation;
  const st = world.waves[team];
  const list = [];
  // 波次升级：每 every_n_waves 波各加一个近战/远程，直到各自上限（数据驱动的压力曲线）
  const extra = esc ? Math.min(esc.max_extra_each, Math.floor((waveIndex - 1) / esc.every_n_waves)) : 0;
  for (let i = 0; i < cfg.composition.melee + (esc ? extra * esc.add_melee : 0); i++) list.push('melee');
  for (let i = 0; i < cfg.composition.ranged + (esc ? extra * esc.add_ranged : 0); i++) list.push('ranged');
  if (cfg.siege_every_n_waves && waveIndex % cfg.siege_every_n_waves === 0) list.push('siege');
  // 雪球：推掉的建筑越多，之后每波兵的攻城兵越多（数据见 combat_minions.json → snowball）
  const snow = world.data.minions.snowball;
  if (snow) {
    const extra = Math.min(snow.max_extra_siege,
      snow.extra_siege_per_structure_destroyed * (world.teamState[team].structuresDestroyed || 0));
    for (let i = 0; i < extra; i++) list.push('siege');
  }
  list.forEach((typeId, i) => st.pending.push({ typeId, at: world.time + i * cfg.spawn_stagger_sec, index: i }));
  world.events.emit(EV.WAVE_SPAWNED, { team, waveIndex, size: list.length });
}

/**
 * 决胜期步数（0 = 常规阶段）。数据来自 assets/data/combat_minions.json → late_game_pressure。
 * 导出以便 tests/unit 直接验证这条收敛曲线。
 */
export function pressureStep(world) {
  const lg = world.data.minions.late_game_pressure;
  if (!lg || !lg.enabled) return 0;
  const minutes = world.time / 60;
  if (minutes < lg.start_min) return 0;
  return Math.min(lg.max_steps, 1 + Math.floor((minutes - lg.start_min) / lg.step_min));
}

function spawnMinion(world, team, typeId, index) {
  const cfg = world.data.minions;
  const jitter = cfg.wave.spawn_jitter_units;
  const base = world.data.map.bases[team].nexus;
  const x = base[0] + world.rng.range(-jitter, jitter);
  const y = base[1] + world.rng.range(-jitter, jitter);
  const minutes = world.time / 60;
  const scalePct = cfg.scaling.health_per_min_pct * minutes;
  const laneDist = team === 'radiant' ? 0 : world.lanePath.length;
  const direction = team === 'radiant' ? 1 : -1;
  const m = createMinion(world.data, team, typeId, x, y, laneDist, direction, scalePct);
  // 伤害缩放独立于生命缩放（数据里两条曲线不同）
  m.stats.attack_damage *= 1 + cfg.scaling.damage_per_min_pct * minutes;
  // 对建筑伤害单独成长：建筑血量不成长，这条曲线保证后期兵线一定推得动塔
  m.bonusVsStructures = 1 + (cfg.scaling.structure_damage_per_min_pct || 0) * minutes;
  // 决胜期：生命/伤害/对建筑伤害按步数指数成长，出兵压力也更大 ⇒ 一局必然收敛
  const lg = cfg.late_game_pressure;
  const step = pressureStep(world);
  if (step > 0 && lg) {
    m.stats.max_health *= Math.pow(lg.health_mult_per_step, step);
    m.health = m.stats.max_health;
    m.stats.attack_damage *= Math.pow(lg.damage_mult_per_step, step);
    m.bonusVsStructures *= Math.pow(lg.structure_damage_mult_per_step, step);
  }
  m.spawnIndex = index;
  addEntity(world, m);
  return m;
}

/* ---------------------------------------------------------------- 建筑无敌解锁 */
/**
 * 解锁顺序 = map_lane.json 中 towers 数组顺序，最后才是 nexus。
 * 前一个未摧毁 ⇒ 后一个 invulnerable（story-003 验收标准）。
 */
export function structuresInOrder(world, team) {
  // 顺序在 createWorld 里按"离己方水晶由远到近"算好并缓存（world.structureOrder），
  // 这里只做兜底，避免每 tick 过滤+排序产生垃圾。
  if (world.structureOrder?.[team]) return world.structureOrder[team];
  const nx = world.data.map.bases[team].nexus;
  const all = world.entities.filter(e => e.kind === 'structure' && e.team === team);
  return all.sort((a, b) => distToNexus(b, nx) - distToNexus(a, nx));
}

function distToNexus(s, nx) {
  if (s.structureKind === 'nexus') return -1;                 // nexus 永远排最后
  return Math.hypot(s.x - nx[0], s.y - nx[1]);
}

export function refreshInvulnerability(world) {
  for (const team of TEAMS) {
    const ordered = structuresInOrder(world, team);
    let unlocked = false;
    for (const s of ordered) {
      if (!s.alive) continue;
      s.invulnerable = !unlocked;
      unlocked = true;      // 只有最靠前的存活建筑可被攻击
    }
  }
}

export function nexusOf(world, team) {
  return world.entities.find(e => e.kind === 'structure' && e.team === team && e.structureKind === 'nexus');
}

/* ---------------------------------------------------------------- 胜负 */
export function checkVictory(world) {
  if (world.over) return;
  for (const team of TEAMS) {
    const nx = nexusOf(world, team);
    if (!nx || !nx.alive) {
      const winner = team === 'radiant' ? 'dire' : 'radiant';
      endGame(world, winner, 'nexus_destroyed');
      return;
    }
  }
}

export function endGame(world, winner, reason) {
  if (world.over) return;
  world.over = true;
  world.winner = winner;
  world.endReason = reason;
  world.events.emit(EV.GAME_OVER, { winner, reason, time: world.time, summary: summarize(world) });
}

export function summarize(world) {
  const out = { time: world.time, winner: world.winner, teams: {} };
  for (const team of TEAMS) {
    const h = world.heroByTeam[team];
    out.teams[team] = {
      kills: h.kills, deaths: h.deaths, cs: h.cs,
      gold: Math.floor(h.goldEarned), level: h.level,
      items: h.items.slice(),
      structuresDestroyed: world.teamState[team].structuresDestroyed,
      structuresAlive: world.entities.filter(e => e.kind === 'structure' && e.team === team && e.alive).length
    };
  }
  return out;
}

/* ---------------------------------------------------------------- 野怪营地 */
export function updateCamps(world) {
  for (const camp of Object.values(world.camps)) {
    if (camp.state === 'waiting' && world.time >= camp.def.spawn_after_sec) camp.state = 'ready';
    if (camp.state === 'dead' && world.time >= camp.respawnAt) camp.state = 'ready';
    if (camp.state === 'ready') spawnCamp(world, camp);
  }
}

function spawnCamp(world, camp) {
  const pos = world.data.map.jungle_camps[camp.id];
  if (!pos) return;
  camp.units.length = 0;
  let i = 0;
  for (const group of camp.def.monsters) {
    for (let k = 0; k < group.count; k++) {
      const angle = (i / Math.max(1, totalMonsters(camp))) * Math.PI * 2;
      const r = 46 + (i % 3) * 26;
      const x = pos[0] + Math.cos(angle) * r;
      const y = pos[1] + Math.sin(angle) * r;
      const n = createNeutral(world.data, camp.id, group.type, x, y, pos[0], pos[1]);
      addEntity(world, n);
      camp.units.push(n.id);
      i++;
    }
  }
  camp.state = 'alive';
  world.events.emit('camp_spawned', { campId: camp.id, count: i });
}

function totalMonsters(camp) {
  return camp.def.monsters.reduce((s, g) => s + g.count, 0);
}

/**
 * 营地清空：施加增益 + 设置刷新时间。
 * @param killerTeam 'radiant' | 'dire'
 */
export function onCampCleared(world, camp, killer, killerTeam) {
  const buffDef = world.data.jungle.buffs[camp.def.buff];
  camp.state = 'dead';
  camp.respawnAt = world.time + camp.def.respawn_sec;
  camp.units.length = 0;
  if (!buffDef) return;
  const mods = modifiersFromJungleBuff(buffDef);
  const targets = buffDef.team_wide
    ? world.heroes.filter(h => h.team === killerTeam)
    : (killer?.kind === 'hero' ? [killer] : []);
  for (const h of targets) {
    addBuff(h.buffs, {
      id: buffDef.name_key || camp.def.buff,
      duration: buffDef.duration,
      modifiers: mods,
      lost_on_death: !!buffDef.lost_on_death,
      team_wide: !!buffDef.team_wide,
      icon: buffDef.icon,
      source_id: camp.id,
      data: { campId: camp.id, labelKey: buffDef.name_key }
    }, world.time);
    h.statsDirty = true;
    world.events.emit(EV.BUFF_GAINED, { heroId: h.id, buffId: camp.def.buff, campId: camp.id });
  }
  if (buffDef.team_gold) {
    for (const h of world.heroes.filter(x => x.team === killerTeam)) addGold(world, h, buffDef.team_gold, 'camp');
  }
  world.events.emit(EV.CAMP_CLEARED, { campId: camp.id, team: killerTeam });
}

/** 供 HUD 显示：营地状态与倒计时（读模拟状态，不改状态）。 */
export function campStatus(world, campId) {
  const camp = world.camps[campId];
  if (!camp) return null;
  if (camp.state === 'waiting') return { state: 'waiting', remaining: Math.max(0, camp.def.spawn_after_sec - world.time) };
  if (camp.state === 'dead') return { state: 'dead', remaining: Math.max(0, camp.respawnAt - world.time) };
  return { state: 'alive', remaining: 0 };
}
