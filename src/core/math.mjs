/**
 * src/core/math.js — 2D 数学。
 *
 * 规则依据 .claude/rules/engine-code.md：热路径零分配。
 * 因此所有向量运算都写入调用方提供的 out 对象（或返回标量），
 * 不在每 tick 的循环里创建临时对象。
 */

export const EPSILON = 1e-6;

export function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
export function lerp(a, b, t) { return a + (b - a) * t; }
/** 帧率无关的指数平滑：factor 越大越快（单位 1/秒）。 */
export function damp(a, b, factor, dt) { return lerp(a, b, 1 - Math.exp(-factor * dt)); }

export function dist2(ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; }
export function dist(ax, ay, bx, by) { return Math.sqrt(dist2(ax, ay, bx, by)); }

/** 归一化方向写入 out = {x,y}；零长度时保持 out 不变并返回 false。 */
export function dirTo(ax, ay, bx, by, out) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < EPSILON) return false;
  out.x = dx / len; out.y = dy / len;
  return true;
}

/** 点 p 到线段 ab 的最近点，写入 out；返回最近距离的平方。 */
export function closestOnSegment(px, py, ax, ay, bx, by, out) {
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 < EPSILON ? 0 : ((px - ax) * abx + (py - ay) * aby) / len2;
  t = clamp(t, 0, 1);
  out.x = ax + abx * t; out.y = ay + aby * t;
  return dist2(px, py, out.x, out.y);
}

/** 折线路径：把 path（[[x,y],...]）预展开为累计长度表，供按距离取点。 */
export function buildPath(path) {
  const pts = path.map(p => ({ x: p[0], y: p[1] }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y));
  return { pts, cum, length: cum[cum.length - 1] };
}

/** 按沿路径的距离取点与切线方向，写入 out = {x,y,dx,dy}。 */
export function pointAtDistance(built, d, out) {
  const { pts, cum, length } = built;
  const dd = clamp(d, 0, length);
  let i = 1;
  while (i < cum.length - 1 && cum[i] < dd) i++;
  const a = pts[i - 1], b = pts[i];
  const seg = cum[i] - cum[i - 1] || 1;
  const t = (dd - cum[i - 1]) / seg;
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.dx = (b.x - a.x) / seg;
  out.dy = (b.y - a.y) / seg;
  return out;
}

/** 离路径最近点的距离值（用于把单位投影回车路）。 */
export function distanceAlongPath(built, px, py) {
  const tmp = { x: 0, y: 0 };
  let best = Infinity, bestD = 0;
  for (let i = 1; i < built.pts.length; i++) {
    const a = built.pts[i - 1], b = built.pts[i];
    const d2 = closestOnSegment(px, py, a.x, a.y, b.x, b.y, tmp);
    if (d2 < best) { best = d2; bestD = built.cum[i - 1] + dist(a.x, a.y, tmp.x, tmp.y); }
  }
  return bestD;
}

/** 圆与线段的相交判定（技能弹道用）。 */
export function segmentHitsCircle(ax, ay, bx, by, cx, cy, r) {
  const tmp = { x: 0, y: 0 };
  return closestOnSegment(cx, cy, ax, ay, bx, by, tmp) <= r * r;
}

/** 角度差归一化到 [-PI, PI]。 */
export function angleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
