/**
 * tools/render_evidence.mjs — 无头产出 QA 画面证据（story-007 的 Test Evidence）。
 *
 * 它做的是"真的把游戏跑起来、看一眼、留下截图"：
 *   1. 用真实的 src/gameplay/sim.mjs 跑一局（双方都由 src/ai/hero_ai.mjs 驱动，会产生真实战斗）
 *   2. 在若干关键时刻调用**浏览器用的同一套**渲染模块（src/render/draw.mjs + hud.mjs）
 *      构建绘制指令，再用 tools/png_encoder.mjs 光栅化成 PNG
 *   3. 每张图配一个 .json 边车：视口尺寸、文案清单与包围盒、越界绘制项、断言结果
 *
 * 用法：node tools/render_evidence.mjs [--out production/qa/evidence] [--max-seconds 900]
 * 输出：production/qa/evidence/story-007-*.png (+ .json)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadGameData } from '../src/gameplay/data.mjs';
import { createWorld, FIXED_DT } from '../src/gameplay/world.mjs';
import { tick } from '../src/gameplay/sim.mjs';
import { createHeroAi, updateHeroAi } from '../src/ai/hero_ai.mjs';
import { createView, buildWorldDrawList } from '../src/render/draw.mjs';
import { buildHudDrawList } from '../src/render/hud.mjs';
import { createUiState } from '../src/ui/ui_state.mjs';
import { createFramebuffer, rasterize, encodePng } from './png_encoder.mjs';
import { endGame } from '../src/gameplay/objectives.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argVal = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const OUT_DIR = join(ROOT, argVal('--out', 'production/qa/evidence'));
const MAX_SECONDS = Number(argVal('--max-seconds', '900'));
const VIEW_W = 1440, VIEW_H = 860;

mkdirSync(OUT_DIR, { recursive: true });

const data = await loadGameData();
const ui = createUiState(data, { playerTeam: 'radiant', prefs: { scale: 1.0 } });
const view = createView(VIEW_W, VIEW_H);
view.zoom = data.map.camera.zoom_default;
const worldList = [], hudList = [], hotspots = [];

const world = createWorld(data, { seed: 4242 });
const aiDire = createHeroAi(world, world.heroByTeam.dire, data.ai);
const aiRadiant = createHeroAi(world, world.heroByTeam.radiant, data.ai);

let feed = [];
world.events.on('hero_killed', p => feed.unshift({ text: `kill t=${world.time.toFixed(0)}s ${p.killerTeam}→${p.victimTeam}`, color: '#e8ecf6', life: 5, maxLife: 5 }));
world.events.on('structure_destroyed', p => feed.unshift({ text: `${p.team} ${p.kind} destroyed t=${world.time.toFixed(0)}s`, color: '#f5c542', life: 6, maxLife: 6 }));
ui.feed = feed;

const shots = [];
let midgameShot = false;
let fxShot = false;

function cameraOn(hero) {
  view.camX = hero.x; view.camY = hero.y;
  const halfW = VIEW_W / 2 / view.zoom, halfH = VIEW_H / 2 / view.zoom;
  view.camX = Math.min(Math.max(view.camX, halfW * 0.35), data.map.world.width - halfW * 0.35);
  view.camY = Math.min(Math.max(view.camY, halfH * 0.35), data.map.world.height - halfH * 0.35);
}

function shoot(name, mutateUi, note) {
  const me = world.heroByTeam[ui.playerTeam];
  cameraOn(me);
  const saved = { scale: ui.scale, colorblind: ui.colorblind, shopOpen: ui.shopOpen, settingsOpen: ui.settingsOpen, debug: ui.debug };
  if (mutateUi) mutateUi(ui);
  buildWorldDrawList(world, view, ui, worldList);
  buildHudDrawList(world, view, ui, hudList, hotspots);
  const fb = createFramebuffer(VIEW_W, VIEW_H);
  const r1 = rasterize(fb, worldList);
  const r2 = rasterize(fb, hudList);
  const png = encodePng(fb);
  const file = join(OUT_DIR, `${name}.png`);
  writeFileSync(file, png);

  const texts = [...r1.texts, ...r2.texts];
  const oov = [...r1.outOfViewport, ...r2.outOfViewport];
  // HUD 文案越界 = story-007 验收标准"HUD 必须在可见范围内"失败
  const hudTextOOV = r2.outOfViewport.filter(o => o.op === 'text');
  const sidecar = {
    shot: name,
    note,
    captured_at_game_time_sec: +world.time.toFixed(2),
    viewport: { w: VIEW_W, h: VIEW_H, zoom: +view.zoom.toFixed(3), camera: [Math.round(view.camX), Math.round(view.camY)] },
    ui: { scale: ui.scale, colorblind: ui.colorblind, shopOpen: ui.shopOpen, settingsOpen: ui.settingsOpen, locale: ui.strings.locale },
    world_state: {
      tick: world.tickCount,
      entities: world.entities.length,
      projectiles: world.projectiles.length,
      effects: world.effects.length,
      particles: world.particles.length,
      float_texts: world.floatTexts.length,
      over: world.over, winner: world.winner,
      radiant: snapshotHero(world.heroByTeam.radiant),
      dire: snapshotHero(world.heroByTeam.dire)
    },
    draw_commands: { world: worldList.length, hud: hudList.length, png_bytes: png.length },
    assertions: {
      hud_text_within_viewport: hudTextOOV.length === 0,
      hud_text_count: r2.texts.length,
      world_text_count: r1.texts.length,
      hotspots: hotspots.length,
      no_out_of_viewport_text: oov.filter(o => o.op === 'text').length === 0
    },
    hud_texts: r2.texts.map(t => ({ text: t.text, x: t.x, y: t.y, w: t.w, h: t.h })),
    out_of_viewport: oov
  };
  writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(sidecar, null, 1));
  shots.push({ name, ...sidecar.assertions, png_bytes: png.length, t: sidecar.captured_at_game_time_sec });
  Object.assign(ui, saved);
}

function snapshotHero(h) {
  return {
    level: h.level, hp: Math.round(h.health), maxHp: Math.round(h.stats.max_health),
    mana: Math.round(h.mana), gold: Math.floor(h.gold), cs: h.cs, kills: h.kills, deaths: h.deaths,
    items: h.items.slice(), skill_levels: { ...h.skillLevels }, pos: [Math.round(h.x), Math.round(h.y)],
    alive: h.alive
  };
}

/* ---------------------------------------------------------------- 跑一局 */
const t0 = Date.now();
let lastSample = 0;
const maxTicks = Math.ceil(MAX_SECONDS / FIXED_DT);
for (let i = 0; i < maxTicks && !world.over; i++) {
  tick(world, { radiant: updateHeroAi(world, aiRadiant, FIXED_DT), dire: updateHeroAi(world, aiDire, FIXED_DT) });
  if (feed.length > 6) feed.length = 6;

  // 战斗特效帧：抓一个弹道 + 粒子 + 伤害数字同时存在的真实瞬间（不重跑、不摆拍）
  if (!fxShot && world.time > 28 && world.projectiles.length >= 2 && world.particles.length >= 4) {
    shoot('story-007-combat-fx', null,
      `战斗特效：弹道 ${world.projectiles.length} / 读条 ${world.effects.length} / 粒子 ${world.particles.length} / 伤害数字 ${world.floatTexts.length}（tick ${world.tickCount}）`);
    fxShot = true;
  }

  // 中期 HUD（有等级、有装备、有战斗记录）
  const me = world.heroByTeam.radiant;
  if (!midgameShot && me.level >= 5 && me.items.length >= 2 && world.time > 90) {
    shoot('story-007-hud-midgame', null, '中期对局：等级/装备/技能冷却/双方计分板/野区计时/小地图全部可见');
    midgameShot = true;
  }
  if (world.time - lastSample > 60) {
    lastSample = world.time;
    process.stderr.write(`  t=${world.time.toFixed(0)}s lvl=${me.level} cs=${me.cs} gold=${Math.floor(me.gold)} k/d=${me.kills}/${me.deaths} ents=${world.entities.length}\n`);
  }
}
if (!midgameShot) shoot('story-007-hud-midgame', null, '未达成中期条件，按结束状态截取');
if (!fxShot) shoot('story-007-combat-fx', null, '整局未出现足够的战斗特效（弹道+粒子），按结束状态截取');

// 商店面板
shoot('story-007-shop', u => { u.shopOpen = true; }, '商店打开：物品价格、可购买状态、金钱、装备栏占用');
// 设置面板（含键位重映射）
shoot('story-007-settings', u => { u.settingsOpen = true; }, '设置面板：字号缩放/色盲配色/静音/射程显示 + 键位重映射');
// 字号 1.5 缩放：验收"缩放后 HUD 不溢出错位"
shoot('story-007-scale-1_5', u => { u.scale = 1.5; }, 'UI 字号 1.5×：HUD 不得溢出视口（见边车 assertions）');
// 色盲友好配色
shoot('story-007-colorblind', u => { u.colorblind = true; }, '色盲友好配色：青/橙阵营 + 形状编码并行');
// 调试面板
shoot('story-007-debug', u => { u.debug = true; }, '调试面板：tick/实体数/池占用/帧耗时');

// 结算面板
if (!world.over) endGame(world, 'radiant', 'evidence_max_seconds_reached');
shoot('story-007-gameover', null, `结算面板：${world.winner} 胜（reason=${world.endReason}）`);

console.log(JSON.stringify({
  out: OUT_DIR.replace(ROOT + '/', ''),
  real_ms: Date.now() - t0,
  game_time_sec: +world.time.toFixed(1),
  over: world.over, winner: world.winner, reason: world.endReason,
  shots
}, null, 1));
