/**
 * tools/browser_smoke.mjs — 在没有浏览器的环境里跑一遍浏览器入口 src/main.mjs。
 *
 * 为什么不用 jsdom：jsdom 不执行 `<script type="module">`，而本项目全部是 ES Modules。
 * 所以这里自建最小 DOM 桩（window/document/canvas/2D context/事件/localStorage/rAF），
 * 然后直接 import main.mjs —— 跑的是**真实**的入口代码、真实的模拟、真实的绘制指令构建，
 * 只有"最终把像素画出来"这一步由记录型 ctx 桩代替。
 *
 * 它检查什么：
 *   1. boot() 能跑完（没有未定义变量 / 错误字段名 / 模块循环）
 *   2. 每帧都有绘制指令产出，且所有 op 都是后端已实现的类型
 *   3. 绘制坐标与文本没有 NaN / "undefined" / "null"（HUD 画到屏幕外这类问题的第一道网）
 *   4. 输入能真正改变模拟（右键移动 → moveTarget 被设置；按键 → 技能/加点/商店）
 *
 * 运行：node tools/browser_smoke.mjs
 * 注意：这是 logic 层冒烟测试，**不替代** story-007 要求的真实画面证据
 *       （那个由 tools/render_evidence.mjs 无头光栅化成 PNG 产出）。
 */
import { performance } from 'node:perf_hooks';

// canvas2d 后端支持的绘制指令 op 集合（用于断言渲染层没有发明后端不认识的指令）
const errors = [];
const warns = [];
const calls = { total: 0, byOp: new Map(), badOps: new Set(), texts: [] };

/* ---------------------------------------------------------------- ctx 桩 */
function makeCtx() {
  const state = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '',
    textAlign: '', textBaseline: '', shadowColor: '', shadowBlur: 0
  };
  const numericMethods = new Set(['fillRect', 'strokeRect', 'clearRect', 'arc', 'arcTo', 'moveTo', 'lineTo', 'fillText', 'strokeText']);
  return new Proxy({
    measureText: t => ({ width: String(t).length * 7 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    setTransform() {}, save() {}, restore() {}, setLineDash() {},
    beginPath() {}, closePath() {}, fill() {}, stroke() {}
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop in state) return state[prop];
      if (prop === 'canvas') return canvasEl;
      return (...args) => {
        calls.total++;
        calls.byOp.set(prop, (calls.byOp.get(prop) || 0) + 1);
        if (numericMethods.has(prop)) {
          const nums = args.filter(a => typeof a === 'number');
          if (nums.some(n => !Number.isFinite(n))) errors.push(`${prop} 收到非有限数值: ${JSON.stringify(args)}`);
        }
        if (prop === 'fillText' || prop === 'strokeText') {
          const t = String(args[0]);
          if (/undefined|null|NaN|\[object/.test(t)) errors.push(`文本渲染出字面量 "${t}"`);
          if (calls.texts.length < 60) calls.texts.push(t);
        }
      };
    },
    set(_t, prop, value) { state[prop] = value; return true; }
  });
}

/* ---------------------------------------------------------------- DOM 桩 */
const listeners = { window: new Map(), canvas: new Map() };
function addListener(reg, type, fn) {
  if (!reg.has(type)) reg.set(type, []);
  reg.get(type).push(fn);
}
function fire(reg, type, ev) {
  const arr = reg.get(type);
  if (!arr) return 0;
  const e = { type, preventDefault() {}, stopPropagation() {}, ...ev };
  for (const fn of arr) fn(e);
  return arr.length;
}

const canvasEl = {
  width: 0, height: 0, style: {},
  getContext: () => ctxStub,
  addEventListener: (t, fn) => addListener(listeners.canvas, t, fn)
};
const ctxStub = makeCtx();
const statusEl = { textContent: 'loading', style: {} };

globalThis.window = {
  innerWidth: 1440, innerHeight: 860, devicePixelRatio: 2,
  addEventListener: (t, fn) => addListener(listeners.window, t, fn),
  removeEventListener() {},
  requestAnimationFrame: fn => setTimeout(() => fn(performance.now()), 16),
  localStorage: (() => {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
  })()
};
globalThis.document = {
  getElementById: id => (id === 'game' ? canvasEl : id === 'status' ? statusEl : null),
  addEventListener: (t, fn) => addListener(listeners.window, t, fn)
};
globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
globalThis.localStorage = globalThis.window.localStorage;
globalThis.devicePixelRatio = 2;
// Node 22 已提供只读的 globalThis.navigator，不要覆盖

const origWarn = console.warn, origErr = console.error;
console.warn = (...a) => { warns.push(a.join(' ')); origWarn(...a); };
console.error = (...a) => { errors.push(a.join(' ')); origErr(...a); };

/* ---------------------------------------------------------------- 启动 */
await import('../src/main.mjs');
await sleep(400);

const api = globalThis.window.__riftlane;
if (!api) {
  origErr('FAIL: window.__riftlane 不存在 — boot() 未完成');
  origErr(errors.slice(0, 10).join('\n'));
  process.exit(1);
}
const { ui, view } = api;
const world = () => api.world;

/* ---------------------------------------------------------------- 驱动输入 */
function pointer(type, x, y, button = 0) { fire(listeners.canvas, type, { clientX: x, clientY: y, button }); }
function key(k, type = 'keydown') { fire(listeners.window, type, { key: k }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const before = { x: world().heroByTeam.radiant.x, y: world().heroByTeam.radiant.y };
pointer('pointermove', 900, 430);
pointer('pointerdown', 900, 430, 2);                 // 右键移动
await sleep(220);
const moveSet = !!world().heroByTeam.radiant.moveTarget;

// 1 级只有 1 个技能点：逐个按键并等一帧，模拟真人节奏
// （同一帧内连按 4 键会让一次性命令互相覆盖 —— 那是测试不真实，不是游戏 bug）
key('1'); await sleep(60);
const ranked = { ...world().heroByTeam.radiant.skillLevels };
const pointsAfter = world().heroByTeam.radiant.skillPoints;
key('2'); await sleep(60);                            // 没有技能点了，应失败并给出提示
const rankedNoPoints = { ...world().heroByTeam.radiant.skillLevels };

pointer('pointermove', 820, 400);
key('q'); await sleep(60);                            // 施放 Q
key('r'); await sleep(60);                            // R 需要 6 级，应失败但不报错
key('b'); await sleep(120);                           // 打开商店
const shopOpened = ui.shopOpen;
pointer('pointerdown', 1250, 262, 0);                 // 点商店第一行（iron_edge 400g，开局 520g 买得起）
await sleep(80);
pointer('pointerdown', 1250, 640, 0);                 // 再点一行贵的：应失败并给出文字反馈
await sleep(120);
key('b'); await sleep(60);
key('f'); await sleep(60);                            // 调试面板
const items = [...world().heroByTeam.radiant.items];

await sleep(900);                                     // 让它多跑些帧
const w = world();
const me = w.heroByTeam.radiant;
const moved = Math.hypot(me.x - before.x, me.y - before.y);

/* ---------------------------------------------------------------- 断言 */
function check(name, cond, detail = '') {
  if (!cond) errors.push(`断言失败: ${name} ${detail}`);
  return cond;
}
check('boot 完成', !!api);
check('模拟在推进', w.tickCount > 20, `ticks=${w.tickCount}`);
check('右键移动写入了 moveTarget', moveSet);
check('英雄实际发生了位移', moved > 20, `moved=${moved.toFixed(1)}`);
check('1 级用掉起始技能点加了 Q', ranked.q === 1, JSON.stringify(ranked));
check('技能点用完', pointsAfter === 0, `points=${pointsAfter}`);
check('没点时再加不生效', rankedNoPoints.w === 0, JSON.stringify(rankedNoPoints));
check('失败反馈已进提示流', ui.feed.some(f => /技能点/.test(f.text)), JSON.stringify(ui.feed.map(f => f.text)));
check('商店可开关', shopOpened === true);
check('买得起的物品能买入', items.length >= 1, JSON.stringify(items));
check('有绘制指令产出', calls.total > 500, `calls=${calls.total}`);
check('HUD 文本已渲染', calls.texts.length > 5, JSON.stringify(calls.texts.slice(0, 6)));
check('无 NaN 坐标', !errors.some(e => e.includes('非有限数值')));
check('无 undefined 文本', !errors.some(e => e.includes('字面量')));

// 所有 op 必须是 canvas2d 后端认识的
for (const op of calls.byOp.keys()) {
  if (!['fillRect', 'strokeRect', 'clearRect', 'arc', 'arcTo', 'moveTo', 'lineTo', 'fillText', 'strokeText',
    'fill', 'stroke', 'beginPath', 'closePath', 'setLineDash', 'save', 'restore', 'setTransform',
    'measureText', 'createLinearGradient'].includes(op)) calls.badOps.add(op);
}
check('没有未实现的 ctx 调用', calls.badOps.size === 0, [...calls.badOps].join(','));

const report = {
  ok: errors.length === 0,
  ticks: w.tickCount,
  time: +w.time.toFixed(2),
  entities: w.entities.length,
  drawCalls: calls.total,
  ctxOps: Object.fromEntries([...calls.byOp].sort((a, b) => b[1] - a[1])),
  heroMovedUnits: +moved.toFixed(1),
  heroPos: [Math.round(me.x), Math.round(me.y)],
  skillLevels: ranked,
  items,
  fps: Math.round(ui.fps),
  renderMsPerFrame: +(ui.lastRenderMs || 0).toFixed(2),
  tickUsPerTick: +((w.perf.lastTickUs || 0)).toFixed(0),
  textSamples: calls.texts.slice(0, 22),
  warnings: warns.slice(0, 8),
  errors: errors.slice(0, 12)
};
console.warn = origWarn; console.error = origErr;
console.log(JSON.stringify(report, null, 1));
process.exit(report.ok ? 0 : 1);
