/**
 * src/render/draw.js — 世界层：模拟状态 → 绘制指令。
 *
 * 只读模拟状态，不回写（渲染不得影响游戏逻辑）。
 * 坐标变换在这里完成，后端只处理屏幕坐标 —— 所以 PNG 光栅器不需要实现变换。
 */
import { paletteFor, teamColor, shapeOf } from './palette.mjs';
import { formatClock, clamp } from '../core/math.mjs';
import { campStatus } from '../gameplay/objectives.mjs';

export function createView(w, h) {
  return { w, h, camX: 0, camY: 0, zoom: 0.82, dpr: 1 };
}

export function worldToScreen(view, x, y, out) {
  out.x = (x - view.camX) * view.zoom + view.w / 2;
  out.y = (y - view.camY) * view.zoom + view.h / 2;
  return out;
}
export function screenToWorld(view, sx, sy, out) {
  out.x = (sx - view.w / 2) / view.zoom + view.camX;
  out.y = (sy - view.h / 2) / view.zoom + view.camY;
  return out;
}

const S = { x: 0, y: 0 };

function visible(view, x, y, pad = 120) {
  worldToScreen(view, x, y, S);
  return S.x > -pad && S.x < view.w + pad && S.y > -pad && S.y < view.h + pad;
}

export function buildWorldDrawList(world, view, ui, out) {
  out.length = 0;
  const P = paletteFor(ui);
  const z = view.zoom;
  const D = world.data;

  // ---- 地形
  out.push({ op: 'rect', x: 0, y: 0, w: view.w, h: view.h, color: P.bgDeep, fill: true });
  const tl = worldToScreen(view, 0, 0, { x: 0, y: 0 });
  out.push({ op: 'rect', x: tl.x, y: tl.y, w: D.map.world.width * z, h: D.map.world.height * z, color: P.terrain, fill: true });

  // 网格（低调，提供运动参考）
  const gs = 300 * z;
  if (gs > 14) {
    for (let gx = tl.x; gx < tl.x + D.map.world.width * z; gx += gs) {
      out.push({ op: 'line', x1: gx, y1: tl.y, x2: gx, y2: tl.y + D.map.world.height * z, color: P.grid, width: 1, alpha: 0.55 });
    }
    for (let gy = tl.y; gy < tl.y + D.map.world.height * z; gy += gs) {
      out.push({ op: 'line', x1: tl.x, y1: gy, x2: tl.x + D.map.world.width * z, y2: gy, color: P.grid, width: 1, alpha: 0.55 });
    }
  }

  // 车路
  const path = D.map.lane_path;
  for (let i = 1; i < path.length; i++) {
    const a = worldToScreen(view, path[i - 1][0], path[i - 1][1], { x: 0, y: 0 });
    const b = worldToScreen(view, path[i][0], path[i][1], { x: 0, y: 0 });
    out.push({ op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: P.lane, width: 132 * z });
    out.push({ op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: P.laneEdge, width: 138 * z, alpha: 0.35 });
  }
  // 泉水
  for (const team of ['radiant', 'dire']) {
    const f = D.map.bases[team].fountain;
    const p = worldToScreen(view, f[0], f[1], { x: 0, y: 0 });
    out.push({ op: 'circle', x: p.x, y: p.y, r: D.map.fountain.radius * z, color: teamColor(P, team), alpha: 0.09, glow: 24 * z });
    out.push({ op: 'ring', x: p.x, y: p.y, r: D.map.fountain.radius * z, width: 2, color: teamColor(P, team), alpha: 0.4, dash: [8, 8] });
  }
  // 野怪营地
  for (const campId of Object.keys(world.camps)) {
    const pos = D.map.jungle_camps[campId];
    if (!pos) continue;
    const p = worldToScreen(view, pos[0], pos[1], { x: 0, y: 0 });
    const st = campStatus(world, campId);
    const alive = st.state === 'alive';
    out.push({ op: 'ring', x: p.x, y: p.y, r: 96 * z, width: 2, color: alive ? P.neutral : P.textFaint, alpha: alive ? 0.55 : 0.3, dash: [6, 10] });
    if (!alive && visible(view, pos[0], pos[1])) {
      const label = st.state === 'waiting'
        ? ui.t('hud_spawn_in', { sec: Math.ceil(st.remaining) })
        : ui.t('hud_camp_respawn', { sec: Math.ceil(st.remaining) });
      out.push({ op: 'text', x: p.x, y: p.y, text: label, size: 12 * ui.scale, color: P.textDim, align: 'center', baseline: 'middle', shadow: true });
    }
  }

  // ---- 玩家指示器：移动目标 / 攻击射程
  const me = world.heroByTeam[ui.playerTeam];
  if (me?.alive) {
    if (me.moveTarget) {
      const p = worldToScreen(view, me.moveTarget.x, me.moveTarget.y, { x: 0, y: 0 });
      out.push({ op: 'ring', x: p.x, y: p.y, r: 16 * z, width: 2.5, color: P.teamRadiant, alpha: 0.8 });
      out.push({ op: 'ring', x: p.x, y: p.y, r: 7 * z, width: 2, color: P.teamRadiant, alpha: 0.9 });
    }
    if (ui.showRanges) {
      const p = worldToScreen(view, me.x, me.y, { x: 0, y: 0 });
      out.push({ op: 'ring', x: p.x, y: p.y, r: me.stats.attack_range * z, width: 1.5, color: P.textFaint, alpha: 0.45, dash: [5, 7] });
    }
    if (me.attackMoveTarget) {
      const p = worldToScreen(view, me.attackMoveTarget.x, me.attackMoveTarget.y, { x: 0, y: 0 });
      out.push({ op: 'ring', x: p.x, y: p.y, r: 20 * z, width: 2, color: P.danger, alpha: 0.7, dash: [4, 4] });
    }
  }

  // ---- 延迟效果（读条圈）
  for (const fx of world.effects) {
    if (!visible(view, fx.x, fx.y, fx.radius * z + 40)) continue;
    const p = worldToScreen(view, fx.x, fx.y, { x: 0, y: 0 });
    const prog = clamp((world.time - fx.spawnAt) / Math.max(0.001, fx.detonateAt - fx.spawnAt), 0, 1);
    const friendly = fx.team === ui.playerTeam;
    out.push({ op: 'circle', x: p.x, y: p.y, r: fx.radius * z, color: friendly ? P.telegraphAlly : P.telegraph, alpha: 0.13 + 0.1 * prog });
    out.push({ op: 'ring', x: p.x, y: p.y, r: fx.radius * z, width: 2.5, color: friendly ? P.telegraphAlly : P.telegraph, alpha: 0.55 + 0.35 * prog });
    out.push({ op: 'ring', x: p.x, y: p.y, r: fx.radius * z * prog, width: 3, color: friendly ? P.telegraphAlly : P.telegraph, alpha: 0.85 });
  }

  // ---- 实体（按 kind 排序绘制：建筑 → 小兵/中立 → 英雄）
  const ents = world.entities;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e.alive) continue;
      if (e.kind === 'structure' && pass !== 0) continue;
      if ((e.kind === 'minion' || e.kind === 'neutral') && pass !== 1) continue;
      if (e.kind === 'hero' && pass !== 2) continue;
      if (!visible(view, e.x, e.y, 160)) continue;
      drawEntity(world, view, ui, P, e, out, z);
    }
  }

  // ---- 弹道
  for (const p of world.projectiles) {
    if (!visible(view, p.x, p.y, 80)) continue;
    const s = worldToScreen(view, p.x, p.y, { x: 0, y: 0 });
    const col = p.color === 'spell' ? P.spell : teamColor(P, p.team);
    if (p.kind === 'line') {
      const len = Math.hypot(p.vx, p.vy) || 1;
      const tx = s.x - (p.vx / len) * 46 * z, ty = s.y - (p.vy / len) * 46 * z;
      out.push({ op: 'line', x1: tx, y1: ty, x2: s.x, y2: s.y, color: col, width: p.radius * 1.5 * z, alpha: 0.9 });
      out.push({ op: 'circle', x: s.x, y: s.y, r: p.radius * 0.7 * z, color: '#ffffff', glow: 16 * z, alpha: 0.95 });
    } else {
      out.push({ op: 'circle', x: s.x, y: s.y, r: p.radius * z, color: col, glow: 12 * z });
    }
  }

  // ---- 粒子
  for (const p of world.particles) {
    if (!visible(view, p.x, p.y, 20)) continue;
    const s = worldToScreen(view, p.x, p.y, { x: 0, y: 0 });
    const a = clamp(p.life / p.maxLife, 0, 1);
    out.push({ op: 'circle', x: s.x, y: s.y, r: Math.max(0.6, p.size * z * a), color: colorOf(P, p.color), alpha: a });
  }

  // ---- 伤害数字
  for (const t of world.floatTexts) {
    if (!visible(view, t.x, t.y, 40)) continue;
    const s = worldToScreen(view, t.x, t.y, { x: 0, y: 0 });
    const a = clamp(t.life / t.maxLife, 0, 1);
    const col = t.color === 'magic' ? P.damageMagic : t.color === 'true' ? P.damageTrue : P.damagePhysical;
    out.push({ op: 'text', x: s.x, y: s.y, text: t.text, size: t.size * ui.scale * z, color: col, alpha: a, align: 'center', bold: true, shadow: true });
  }
  return out;
}

function colorOf(P, name) {
  return P[name] || name || P.spark;
}

function drawEntity(world, view, ui, P, e, out, z) {
  const s = worldToScreen(view, e.x, e.y, { x: 0, y: 0 });
  const r = e.radius * z;
  const col = teamColor(P, e.team);
  const shape = shapeOf(e);
  const isMine = e.team === ui.playerTeam;

  if (e.kind === 'structure') {
    // 建筑底座
    out.push({ op: 'circle', x: s.x, y: s.y, r: r * 1.35, color: col, alpha: 0.1 });
    if (shape === 'nexus') {
      out.push({ op: 'poly', x: s.x, y: s.y, points: hexPoints(s.x, s.y, r * 1.15), color: col, alpha: 0.85, stroke: '#ffffff', lineWidth: 2, glow: 26 * z });
      out.push({ op: 'poly', points: hexPoints(s.x, s.y, r * 0.6, Math.PI / 6), color: P.bgDeep, alpha: 0.75 });
    } else {
      out.push({ op: 'poly', points: towerPoints(s.x, s.y, r), color: col, alpha: 0.9, stroke: '#ffffff', lineWidth: 1.5 });
      out.push({ op: 'circle', x: s.x, y: s.y - r * 0.15, r: r * 0.3, color: P.bgDeep, alpha: 0.8 });
    }
    if (e.invulnerable) {
      out.push({ op: 'ring', x: s.x, y: s.y, r: r * 1.5, width: 2.5, color: P.shield, alpha: 0.75, dash: [7, 6] });
      // 双编码：图形 + 文字（story-007 无障碍要求）
      out.push({ op: 'text', x: s.x, y: s.y - r * 1.9, text: ui.t('hud_invulnerable'), size: 11 * ui.scale, color: P.shield, align: 'center', bold: true, shadow: true });
    }
    if (e.targetId) {
      const t = world.byId.get(e.targetId);
      if (t?.alive) {
        const ts = worldToScreen(view, t.x, t.y, { x: 0, y: 0 });
        out.push({ op: 'line', x1: s.x, y1: s.y, x2: ts.x, y2: ts.y, color: col, width: 1.5, alpha: 0.3, dash: [4, 6] });
      }
    }
    healthBar(out, s.x, s.y - r * (shape === 'nexus' ? 1.75 : 1.55), r * 2.1, 7 * ui.scale, e.health / e.stats.max_health, isMine ? P.health : P.healthEnemy, P, ui.t('structure_' + (shape === 'nexus' ? 'nexus' : 'tower') + '_name'));
    return;
  }

  if (e.kind === 'minion' || e.kind === 'neutral') {
    if (shape === 'square') out.push({ op: 'rect', x: s.x - r, y: s.y - r, w: r * 2, h: r * 2, color: col, fill: true, stroke: '#0a0c12', lineWidth: 1.5 });
    else if (shape === 'hexagon' || shape === 'hexagon_large') out.push({ op: 'poly', points: hexPoints(s.x, s.y, r), color: col, stroke: '#0a0c12', lineWidth: 1.5 });
    else out.push({ op: 'circle', x: s.x, y: s.y, r, color: col, stroke: '#0a0c12', lineWidth: 1.5 });
    if (e.hitFlash > 0) out.push({ op: 'circle', x: s.x, y: s.y, r: r * 1.25, color: '#ffffff', alpha: e.hitFlash * 3 });
    if (e.leashing) out.push({ op: 'ring', x: s.x, y: s.y, r: r * 1.6, width: 1.5, color: P.textFaint, alpha: 0.6, dash: [3, 4] });
    healthBar(out, s.x, s.y - r - 8 * ui.scale, r * 2.2, 4 * ui.scale, e.health / e.stats.max_health, isMine ? P.health : P.healthEnemy, P, null);
    return;
  }

  // 英雄
  const dead = !e.alive;
  out.push({ op: 'circle', x: s.x, y: s.y, r: r * 1.9, color: col, alpha: 0.12, glow: 30 * z });
  if (e.shield > 0) out.push({ op: 'ring', x: s.x, y: s.y, r: r * 1.5, width: 3, color: P.shield, alpha: 0.9 });
  const pts = shape === 'triangle' ? triPoints(s.x, s.y, r * 1.25) : diaPoints(s.x, s.y, r * 1.3);
  out.push({ op: 'poly', points: pts, color: col, stroke: '#ffffff', lineWidth: 2 });
  out.push({ op: 'circle', x: s.x, y: s.y, r: r * 0.34, color: '#0a0c12', alpha: 0.85 });
  if (e.hitFlash > 0) out.push({ op: 'circle', x: s.x, y: s.y, r: r * 1.4, color: '#ffffff', alpha: e.hitFlash * 3.2 });
  // 增益图标（世界层：头顶小方块）
  if (e.buffs?.list.length) {
    const n = e.buffs.list.length;
    for (let i = 0; i < n; i++) {
      out.push({ op: 'rect', x: s.x - (n * 7) / 2 + i * 7, y: s.y - r * 2.5 - 10 * ui.scale, w: 5, h: 5, color: P.buff, fill: true, alpha: 0.9 });
    }
  }
  // 前摇指示
  if (e.windup > 0) {
    const total = e.stats?.windup_sec ?? e.def?.attack?.windup_sec ?? 0.2;
    out.push({ op: 'ring', x: s.x, y: s.y, r: r * 1.7, width: 2.5, color: '#ffffff', a0: -Math.PI / 2, a1: -Math.PI / 2 + Math.PI * 2 * (1 - e.windup / total), alpha: 0.7 });
  }
  const nameKey = e.def?.display_name_key;
  healthBar(out, s.x, s.y - r * 2.1, r * 3.1, 7 * ui.scale, e.health / e.stats.max_health, isMine ? P.health : P.healthEnemy, P,
    nameKey ? ui.t(nameKey) : null, e.mana / Math.max(1, e.stats.max_mana), P.mana,
    isMine ? null : null, e.level);
  if (!isMine && ui.showEnemyLevel) {
    out.push({ op: 'text', x: s.x, y: s.y + r * 2.3, text: 'Lv ' + e.level, size: 11 * ui.scale, color: P.textDim, align: 'center', shadow: true });
  }
  void dead;
}

function healthBar(out, cx, y, w, h, pct, color, P, label, pct2, color2, _unused, level) {
  const x = cx - w / 2;
  out.push({ op: 'rect', x: x - 1, y: y - 1, w: w + 2, h: h + 2 + (pct2 !== undefined ? 3 : 0), color: '#05070c', fill: true, alpha: 0.85 });
  out.push({ op: 'rect', x, y, w: w * clamp(pct, 0, 1), h, color, fill: true });
  if (pct2 !== undefined) out.push({ op: 'rect', x, y: y + h + 1, w: w * clamp(pct2, 0, 1), h: 2.5, color: color2, fill: true });
  if (label) out.push({ op: 'text', x: cx, y: y - 4, text: label, size: 11, color: P.text, align: 'center', shadow: true });
  if (level !== undefined) {
    out.push({ op: 'circle', x: x - 9, y: y + h / 2, r: 8, color: P.panelHi, stroke: P.panelEdge, lineWidth: 1 });
    out.push({ op: 'text', x: x - 9, y: y + h / 2 + 3.5, text: String(level), size: 10, color: P.xp, align: 'center', bold: true });
  }
  void _unused;
}

/** 塔轮廓：带锯齿（crenellation）的梯形，即使无色也能识别为建筑。 */
function towerPoints(cx, cy, r) {
  const w = r * 0.92, top = cy - r * 1.15, bot = cy + r * 0.95;
  const tw = r * 0.66;                       // 顶部半宽
  const p = [];
  p.push(cx - w, bot);                       // 左下
  p.push(cx - tw, top + r * 0.34);           // 左上收腰
  // 顶部锯齿
  const teeth = 3, span = tw * 2, stepX = span / teeth;
  for (let i = 0; i < teeth; i++) {
    const x0 = cx - tw + i * stepX;
    p.push(x0, top + r * 0.34, x0, top, x0 + stepX * 0.62, top, x0 + stepX * 0.62, top + r * 0.34);
  }
  p.push(cx + tw, top + r * 0.34);
  p.push(cx + w, bot);
  return p;
}

function hexPoints(cx, cy, r, rot = 0) {
  const p = [];
  for (let i = 0; i < 6; i++) {
    const a = rot + (Math.PI / 3) * i;
    p.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return p;
}
function triPoints(cx, cy, r) {
  return [cx, cy - r, cx - r * 0.92, cy + r * 0.78, cx + r * 0.92, cy + r * 0.78];
}
function diaPoints(cx, cy, r) {
  return [cx, cy - r, cx + r * 0.82, cy, cx, cy + r, cx - r * 0.82, cy];
}
void formatClock;
