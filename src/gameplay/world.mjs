/**
 * src/gameplay/world.js — 世界容器、实体工厂、空间网格、移动。
 *
 * 分层约束（.claude/rules/gameplay-code.md）：本文件不 import DOM、不 import render/ui，
 * 因此同一份模拟可在浏览器与 Node（测试、无头证据渲染）中运行。
 * 所有数值来自 data（assets/data/*.json），此处不写平衡数字。
 *
 * 实体存活性：alive=false 的实体在 tick 末尾统一回收（回池），
 * entities 数组顺序稳定 ⇒ 遍历顺序确定 ⇒ 模拟确定性（story-001）。
 */
import { createRng } from '../core/rng.mjs';
import { createEventBus } from '../core/events.mjs';
import { createPool } from '../core/pool.mjs';
import { buildPath, clamp, dist, dist2, pointAtDistance, distanceAlongPath } from '../core/math.mjs';
import { emptyModifiers, computeStats, computeUnitStats } from './stats.mjs';
import { createBuffList } from './buffs.mjs';

export const TEAMS = Object.freeze(['radiant', 'dire']);
export const FIXED_DT = 1 / 60;
const GRID_CELL = 240;

let nextId = 1;
export function resetIds() { nextId = 1; }   // 测试用：保证两次运行 id 一致

function baseEntity(kind, team, typeId) {
  return {
    id: nextId++, kind, team, typeId,
    x: 0, y: 0, radius: 16, facing: 1,
    alive: true, health: 1, maxHealth: 1, shield: 0,
    mana: 0, maxMana: 0,
    moveTarget: null, moveSpeed: 0,
    attackCooldown: 0, windup: 0, windupTargetId: 0, windupKind: null,
    targetId: 0, retargetAt: 0,
    buffs: createBuffList(),
    statsDirty: true, stats: null,
    attackCounter: 0,
    hitFlash: 0, deathAt: -1,
    invulnerable: false
  };
}

export function createHero(data, team, heroId, x, y) {
  const def = data.heroes.heroes[heroId];
  const h = baseEntity('hero', team, heroId);
  h.def = def;
  h.x = x; h.y = y;
  h.radius = def.radius;
  h.spawnX = x; h.spawnY = y;
  h.level = data.progression.starting_level;
  h.xp = 0; h.gold = data.progression.starting_gold;
  // 起始等级即拥有对应技能点（MOBA 惯例：1 级就能点一个技能）
  h.skillPoints = (data.progression.skill_points_per_level ?? 1) * (data.progression.starting_level ?? 1);
  h.skillLevels = { passive: 1, q: 0, w: 0, e: 0, r: 0 };
  h.cooldowns = { q: 0, w: 0, e: 0, r: 0 };
  h.items = (def.starting_items || []).slice(0, data.progression.item_slots);
  h.kills = 0; h.deaths = 0; h.cs = 0; h.goldEarned = h.gold; h.damageDealt = 0;
  h.respawnAt = -1;
  h.streak = 0; h.shutdownValue = 0;
  h.mods = emptyModifiers();
  recalcHeroStats(data, h);
  h.health = h.stats.max_health;
  h.mana = h.stats.max_mana;
  return h;
}

/** 英雄属性重算：物品 + buff → mods → computeStats（纯函数）。 */
export function recalcHeroStats(data, hero) {
  const mods = emptyModifiers();
  for (const itemId of hero.items) addItem(data, mods, itemId);
  aggregateInto(hero.buffs, mods);
  hero.mods = mods;
  const prevMaxHp = hero.stats?.max_health ?? 0;
  const prevMaxMp = hero.stats?.max_mana ?? 0;
  hero.stats = computeStats(hero.def, hero.level, mods);
  // 最大生命/法力提升时，保留当前百分比，避免升级瞬间"白掉血"
  if (prevMaxHp > 0 && hero.stats.max_health !== prevMaxHp) {
    hero.health = clamp(hero.health * (hero.stats.max_health / prevMaxHp), 0, hero.stats.max_health);
  }
  if (prevMaxMp > 0 && hero.stats.max_mana !== prevMaxMp) {
    hero.mana = clamp(hero.mana * (hero.stats.max_mana / prevMaxMp), 0, hero.stats.max_mana);
  }
  hero.maxHealth = hero.stats.max_health;
  hero.maxMana = hero.stats.max_mana;
  hero.moveSpeed = hero.stats.move_speed;
  hero.statsDirty = false;
}
function addItem(data, mods, itemId) {
  const item = data.items.items[itemId];
  if (!item) return;
  for (const k in item.stats) {
    const v = item.stats[k];
    if (k.endsWith('_pct')) mods.pct[k] = (mods.pct[k] || 0) + v;
    else mods.flat[k] = (mods.flat[k] || 0) + v;
  }
}
function aggregateInto(bl, out) {
  for (const b of bl.list) {
    const m = b.modifiers;
    if (!m) continue;
    for (const k in m.flat) out.flat[k] = (out.flat[k] || 0) + m.flat[k];
    for (const k in m.pct) out.pct[k] = (out.pct[k] || 0) + m.pct[k];
  }
}

export function createMinion(data, team, typeId, x, y, laneDist, direction, scalePct) {
  const def = data.minions.types[typeId];
  const m = baseEntity('minion', team, typeId);
  m.def = def; m.shape = def.shape;
  m.x = x; m.y = y; m.radius = def.radius;
  m.stats = computeUnitStats(def, scalePct);
  m.health = m.maxHealth = m.stats.max_health;
  m.moveSpeed = m.stats.move_speed;
  m.laneDist = laneDist; m.direction = direction;   // +1 沿路径递增，-1 递减
  m.scalePct = scalePct;
  m.bountyGold = def.bounty_gold; m.bountyXp = def.bounty_xp;
  m.leashCd = 0;            // 拉扯后的免索敌冷却（见 sim.updateMinionMovement 的注释）
  m.statsDirty = false;
  return m;
}

export function createStructure(data, team, kind, x, y, orderIndex) {
  const def = kind === 'nexus' ? data.towers.nexus : data.towers.tower;
  const s = baseEntity('structure', team, kind);
  s.def = def; s.structureKind = kind; s.shape = def.shape;
  s.x = x; s.y = y; s.radius = def.radius;
  s.stats = computeUnitStats(def, 0);
  s.health = s.maxHealth = def.health;
  s.moveSpeed = 0;
  s.orderIndex = orderIndex;
  s.invulnerable = true;          // 由 objectives.refreshInvulnerability 解锁
  s.rampHits = 0; s.rampTargetId = 0; s.rampResetAt = 0;
  s.statsDirty = false;
  return s;
}

export function createNeutral(data, campId, typeId, x, y, homeX, homeY) {
  const def = data.jungle.monster_types[typeId];
  const n = baseEntity('neutral', 'neutral', typeId);
  n.def = def; n.shape = def.shape; n.campId = campId;
  n.x = x; n.y = y; n.radius = def.radius;
  n.homeX = homeX; n.homeY = homeY;
  n.stats = computeUnitStats(def, 0);
  n.health = n.maxHealth = def.health;
  n.moveSpeed = def.move_speed;
  n.bountyGold = def.bounty_gold; n.bountyXp = def.bounty_xp;
  n.leashing = false;
  n.aggroTargetId = 0;
  n.statsDirty = false;
  return n;
}

export function createWorld(data, opts = {}) {
  resetIds();
  const rng = createRng(opts.seed ?? 20261010);
  const lanePath = buildPath(data.map.lane_path);
  const world = {
    data, rng, lanePath,
    fixedDt: FIXED_DT, time: 0, tickCount: 0,
    entities: [], heroes: [], byId: new Map(),
    projectiles: [], effects: [], telegraphs: [],
    particles: [], floatTexts: [],
    events: createEventBus(),
    over: false, winner: null, endReason: null,
    teamState: {},
    waves: {}, camps: {},
    grid: { cell: GRID_CELL, cols: 0, rows: 0, buckets: [] },
    perf: { lastTickUs: 0, warnCount: 0 },
    fx: createFxPools()
  };
  for (const team of TEAMS) {
    world.teamState[team] = { kills: 0, deaths: 0, goldEarned: 0, structuresDestroyed: 0, cs: 0 };
    world.waves[team] = { nextAt: data.minions.wave.first_wave_sec, count: 0, pending: [] };
  }
  // 英雄
  const rad = createHero(data, 'radiant', opts.radiantHero || 'vex',
    data.map.bases.radiant.fountain[0], data.map.bases.radiant.fountain[1]);
  const dire = createHero(data, 'dire', opts.direHero || 'karn',
    data.map.bases.dire.fountain[0], data.map.bases.dire.fountain[1]);
  addEntity(world, rad); addEntity(world, dire);
  world.heroes = [rad, dire];
  world.heroByTeam = { radiant: rad, dire };
  // 建筑。解锁顺序按**几何**推导：离己方水晶最远的塔先解锁，nexus 最后。
  // 不再依赖 map_lane.json 里 towers 数组的书写顺序 —— 曾经 radiant 写成「内塔→外塔」、
  // dire 写成「外塔→内塔」，结果 radiant 外塔永远无敌、双方兵线在中路互耗，
  // 实测一局 25 分钟也推不完（tools/smoke.mjs 的多种子回归现在守这条不变量）。
  world.structureOrder = {};
  for (const team of TEAMS) {
    const nx = data.map.bases[team].nexus;
    const built = data.map.towers[team].map(pos => createStructure(data, team, 'tower', pos[0], pos[1], 0));
    built.sort((a, b) => dist(b.x, b.y, nx[0], nx[1]) - dist(a.x, a.y, nx[0], nx[1]));
    built.forEach((s, i) => { s.orderIndex = i; addEntity(world, s); });
    const nexusEnt = createStructure(data, team, 'nexus', nx[0], nx[1], built.length);
    addEntity(world, nexusEnt);
    world.structureOrder[team] = built.concat([nexusEnt]);   // 稳定引用，refreshInvulnerability 每 tick 直接遍历
  }
  // 野怪营地
  for (const [campId, camp] of Object.entries(data.jungle.camps)) {
    world.camps[campId] = {
      id: campId, def: camp, state: camp.spawn_after_sec > 0 ? 'waiting' : 'ready',
      spawnAt: camp.spawn_after_sec, respawnAt: 0, units: []
    };
  }
  rebuildGrid(world);
  return world;
}

export function addEntity(world, e) {
  world.entities.push(e);
  world.byId.set(e.id, e);
  return e;
}

export function getEntity(world, id) { return id ? world.byId.get(id) : undefined; }

export function removeEntity(world, e) {
  const i = world.entities.indexOf(e);
  if (i >= 0) world.entities.splice(i, 1);
  world.byId.delete(e.id);
}

export function isEnemy(a, b) {
  if (!a || !b || a === b) return false;
  if (a.team === 'neutral' || b.team === 'neutral') return false;  // 中立怪只反击攻击者
  return a.team !== b.team;
}
export function isHostileTo(attacker, target) {
  if (!attacker || !target || attacker === target || !target.alive) return false;
  if (target.team === 'neutral') return true;                 // 谁都能打野
  if (attacker.team === 'neutral') return attacker.aggroTargetId === target.id;
  return attacker.team !== target.team;
}

/* ---------------------------------------------------------------- 空间网格 */
export function rebuildGrid(world) {
  const g = world.grid;
  const cols = Math.ceil(world.data.map.world.width / g.cell) + 1;
  const rows = Math.ceil(world.data.map.world.height / g.cell) + 1;
  if (g.cols !== cols || g.rows !== rows) {
    g.cols = cols; g.rows = rows;
    g.buckets = new Array(cols * rows);
    for (let i = 0; i < g.buckets.length; i++) g.buckets[i] = [];
  }
  for (let i = 0; i < g.buckets.length; i++) g.buckets[i].length = 0;
  const ents = world.entities;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (!e.alive) continue;
    const cx = clamp(Math.floor(e.x / g.cell), 0, cols - 1);
    const cy = clamp(Math.floor(e.y / g.cell), 0, rows - 1);
    g.buckets[cy * cols + cx].push(e);
  }
}

/**
 * 取 (x,y) 半径 r 内的实体，写入 out（复用数组，零分配）。
 * @param {string|null} kindFilter 只收集该 kind
 */
export function queryNear(world, x, y, r, out, kindFilter = null) {
  out.length = 0;
  const g = world.grid, r2 = r * r;
  const c0 = clamp(Math.floor((x - r) / g.cell), 0, g.cols - 1);
  const c1 = clamp(Math.floor((x + r) / g.cell), 0, g.cols - 1);
  const r0 = clamp(Math.floor((y - r) / g.cell), 0, g.rows - 1);
  const r1 = clamp(Math.floor((y + r) / g.cell), 0, g.rows - 1);
  for (let cy = r0; cy <= r1; cy++) {
    for (let cx = c0; cx <= c1; cx++) {
      const bucket = g.buckets[cy * g.cols + cx];
      for (let i = 0; i < bucket.length; i++) {
        const e = bucket[i];
        if (!e.alive) continue;
        if (kindFilter && e.kind !== kindFilter) continue;
        const rr = r + e.radius;
        if (dist2(x, y, e.x, e.y) <= (rr > r ? rr * rr : r2)) out.push(e);
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 移动 */
export function moveTowards(e, tx, ty, dt, speedOverride = null) {
  const speed = speedOverride ?? e.moveSpeed ?? e.stats?.move_speed ?? 0;
  if (speed <= 0) return false;
  const dx = tx - e.x, dy = ty - e.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return false;
  const step = Math.min(len, speed * dt);
  e.x += (dx / len) * step;
  e.y += (dy / len) * step;
  if (dx !== 0) e.facing = dx > 0 ? 1 : -1;
  return len > step;                 // true = 还没到
}

/** 小兵沿车路推进：按 laneDist 取路径点，遇敌停下由 combat 处理。 */
const PATH_OUT = { x: 0, y: 0, dx: 0, dy: 0 };
export function advanceAlongLane(world, m, dt) {
  m.laneDist += m.direction * (m.moveSpeed * dt);
  m.laneDist = clamp(m.laneDist, 0, world.lanePath.length);
  pointAtDistance(world.lanePath, m.laneDist, PATH_OUT);
  m.x = PATH_OUT.x; m.y = PATH_OUT.y;
  if (PATH_OUT.dx !== 0) m.facing = PATH_OUT.dx > 0 ? 1 : -1;
}

export function clampToWorld(world, e) {
  const w = world.data.map.world;
  e.x = clamp(e.x, e.radius, w.width - e.radius);
  e.y = clamp(e.y, e.radius, w.height - e.radius);
}

export function laneDistanceOf(world, x, y) { return distanceAlongPath(world.lanePath, x, y); }

/* ---------------------------------------------------------------- 特效池 */
/** 池对象会被复用：acquire 后必须所有字段都是已知的（core/pool.mjs 的约定）。 */
function resetProjectile(o) {
  o.id = 0; o.x = 0; o.y = 0; o.vx = 0; o.vy = 0; o.speed = 0; o.radius = 8; o.life = 0;
  o.ownerId = 0; o.team = 'radiant'; o.damage = 0; o.damageType = 'physical';
  o.targetId = 0; o.homing = false; o.kind = 'attack'; o.color = 'attack';
  o.width = 0; o.length = 0; o.pierceMinions = false; o.hitsHeroesOnce = false;
  o.parts = null; o.abilityId = null; o.rank = 0; o.slow = null;
  if (!o.hitIds) o.hitIds = [];
  o.hitIds.length = 0;
}

export function createFxPools() {
  return {
    projectiles: createPool(() => ({
      id: 0, x: 0, y: 0, vx: 0, vy: 0, speed: 0, radius: 8, life: 0,
      ownerId: 0, team: 'radiant', damage: 0, damageType: 'physical',
      targetId: 0, homing: false, kind: 'attack', color: 'attack',
      width: 0, length: 0, pierceMinions: false, hitsHeroesOnce: false,
      hitIds: [], parts: null, abilityId: null, rank: 0, slow: null
    }), resetProjectile, 48),
    particles: createPool(() => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 0, size: 2, color: 'spark', shape: 'dot' }), null, 256),
    floatTexts: createPool(() => ({ x: 0, y: 0, text: '', life: 0, maxLife: 0, color: 'damage', size: 14, vy: -28 }), null, 48)
  };
}

/** 世界坐标下的直线弹道/延迟效果通用推进；具体规则在 abilities.mjs / combat.mjs。 */
export function spawnProjectile(world, pools, p) {
  const o = pools.projectiles.acquire();   // 已 reset，不会带上一次的残留字段
  Object.assign(o, p);
  o.id = nextId++;
  world.projectiles.push(o);
  return o;
}

export function spawnParticles(world, pools, x, y, count, opts) {
  for (let i = 0; i < count; i++) {
    const p = pools.particles.acquire();
    const a = world.rng.range(0, Math.PI * 2);
    const sp = world.rng.range(opts.speedMin ?? 40, opts.speedMax ?? 180);
    p.x = x; p.y = y;
    p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
    p.maxLife = p.life = world.rng.range(opts.lifeMin ?? 0.25, opts.lifeMax ?? 0.6);
    p.size = world.rng.range(opts.sizeMin ?? 2, opts.sizeMax ?? 4.5);
    p.color = opts.color ?? 'spark';
    p.shape = opts.shape ?? 'dot';
    world.particles.push(p);
  }
}

export function spawnFloatText(world, pools, x, y, text, color = 'damage', size = 14) {
  const t = pools.floatTexts.acquire();
  t.x = x; t.y = y; t.text = text; t.color = color; t.size = size;
  t.maxLife = t.life = 0.9; t.vy = -30;
  world.floatTexts.push(t);
}
