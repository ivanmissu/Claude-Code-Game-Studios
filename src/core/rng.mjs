/**
 * src/core/rng.js — 确定性随机数与状态哈希。
 *
 * 规则依据 .claude/rules/engine-code.md（API 稳定、无隐藏全局状态）与
 * docs/engine-reference/web/VERSION.md（模拟内禁用 Math.random）。
 *
 * 模拟中的每一次随机都必须走这里：种子相同 + 调用顺序相同 ⇒ 结果逐位相同，
 * 这是 tests/unit/test_determinism.mjs 与 tools/render_evidence.mjs 的前提。
 */

/** mulberry32 — 32 位状态，周期 2^32，足够一局游戏使用且实现极短。 */
export function createRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  const rng = {
    /** @returns {number} [0,1) */
    next() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    /** [min,max) 均匀分布 */
    range(min, max) { return min + (max - min) * rng.next(); },
    /** 整数 [min,max] 闭区间 */
    int(min, max) { return Math.floor(min + (max - min + 1) * rng.next()); },
    /** 概率判定，p ∈ [0,1] */
    chance(p) { return rng.next() < p; },
    /** 数组随机一项；空数组返回 undefined（调用方负责处理） */
    pick(arr) { return arr.length ? arr[Math.floor(rng.next() * arr.length)] : undefined; },
    /** 当前内部状态，用于快照/恢复与确定性断言 */
    getState() { return s; },
    setState(v) { s = v >>> 0; }
  };
  return rng;
}

/**
 * 字符串化数字为固定精度，避免浮点尾差让哈希在不同平台上不同。
 * 模拟状态比较一律走这里，不直接比较 === 。
 */
export function quantize(n, digits = 6) {
  if (!Number.isFinite(n)) return Number.isNaN(n) ? 'NaN' : n > 0 ? 'Inf' : '-Inf';
  const f = Math.pow(10, digits);
  return String(Math.round(n * f) / f);
}

/** FNV-1a 32 位字符串哈希——用于状态指纹。 */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 把一串数字压成一个 32 位指纹。 */
export function hashNumbers(values) {
  let h = 0x811c9dc5;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const q = Number.isFinite(v) ? Math.round(v * 1e4) : (Number.isNaN(v) ? -1 : -2);
    h ^= q & 0xffff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (q >>> 16) & 0xffff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
