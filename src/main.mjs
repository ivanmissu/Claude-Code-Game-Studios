/**
 * src/main.js — 浏览器入口：canvas、输入、音频、固定步长循环。
 *
 * 分层：本文件是唯一允许碰 DOM 的地方。它把浏览器输入翻译成 input_state 交给
 * src/gameplay/sim.js，再把模拟状态交给 src/render/**。反向依赖一律禁止
 * （.claude/rules/gameplay-code.md：gameplay 不得引用 UI）。
 */
import { loadGameData } from './gameplay/data.mjs';
import { createWorld, queryNear, FIXED_DT } from './gameplay/world.mjs';
import { tick, createInputState } from './gameplay/sim.mjs';
import { createHeroAi, updateHeroAi, debugAi } from './ai/hero_ai.mjs';
import { createView, buildWorldDrawList, screenToWorld, worldToScreen } from './render/draw.mjs';
import { buildHudDrawList } from './render/hud.mjs';
import { renderDrawList, makeMeasurer } from './render/canvas2d.mjs';
import { createUiState } from './ui/ui_state.mjs';
import { EV } from './core/events.mjs';
import { clamp, damp, dist2 } from './core/math.mjs';
import { createAudio } from './ui/audio.mjs';

const MAX_FRAME_DT = 0.25;      // 切标签页回来时的一次性大 dt 上限
const FRAME_BUDGET_MS = 16.67;  // = project.yaml → performance.frame_budget_ms
const FPS_TARGET = 60;          // = project.yaml → performance.target_framerate
const WORLD_PT = { x: 0, y: 0 };
const NEAR = [];

async function boot() {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const data = await loadGameData();
  const ui = createUiState(data, { playerTeam: 'radiant' });
  const view = createView(window.innerWidth, window.innerHeight);
  const drawList = [];
  const hudList = [];
  const hotspots = [];
  const measure = makeMeasurer(ctx);
  ui.measure = measure;

  let world = null, ai = null, audio = createAudio(ui);
  const input = { radiant: createInputState(), dire: createInputState() };

  function newGame() {
    world = createWorld(data, { seed: (Date.now() & 0x7fffffff) || 1 });
    ai = createHeroAi(world, world.heroByTeam.dire, data.ai);
    ui.feed.length = 0;
    ui.shopOpen = false;
    wireEvents();
    hookCamera();
  }

  function hookCamera() {
    const me = world.heroByTeam[ui.playerTeam];
    if (me) { view.camX = me.x; view.camY = me.y; }
  }

  /* ---------------------------------------------------------- 事件 → 提示流/音效 */
  function wireEvents() {
    const e = world.events;
    const nameOf = id => {
      const u = world.byId.get(id);
      return u?.def?.display_name_key ? ui.t(u.def.display_name_key) : '?';
    };
    e.on(EV.HERO_KILLED, p => {
      const killer = world.byId.get(p.killerId);
      const victim = world.byId.get(p.victimId);
      const txt = p.byStructure || !killer
        ? ui.t('hud_hero_killed_by_tower', { victim: nameOf(p.victimId) })
        : ui.t('hud_hero_killed', { killer: nameOf(p.killerId), victim: nameOf(p.victimId) });
      const mine = p.victimTeam === ui.playerTeam;
      ui.pushFeed(txt, mine ? '#ff5e6c' : '#54d97a');
      audio.death(mine);
    });
    e.on(EV.STRUCTURE_DESTROYED, p => {
      const s = world.byId.get(p.structureId);
      ui.pushFeed(ui.t('hud_tower_destroyed', {
        team: ui.t(p.team === 'radiant' ? 'team_radiant' : 'team_dire'),
        structure: ui.t(p.kind === 'nexus' ? 'structure_nexus_name' : 'structure_tower_name')
      }), p.team === ui.playerTeam ? '#ff5e6c' : '#f5c542');
      audio.structure();
      void s;
    });
    e.on(EV.LEVEL_GAINED, p => {
      if (p.team !== ui.playerTeam) return;
      ui.pushFeed(ui.t('hud_level_up', { hero: nameOf(p.heroId), level: p.level }), '#f5c542');
      audio.levelUp();
    });
    e.on(EV.ITEM_BOUGHT, p => { audio.buy(); ui.pushFeed(ui.t('hud_bought', { name: ui.t(world.data.items.items[p.itemId].name_key) }), '#f5c542'); });
    e.on(EV.ITEM_SOLD, p => { audio.buy(); ui.pushFeed(ui.t('hud_sold', { name: ui.t(world.data.items.items[p.itemId].name_key) }), '#98a2b8'); });
    e.on(EV.BUFF_GAINED, p => {
      if (world.byId.get(p.heroId)?.team !== ui.playerTeam) return;
      const camp = world.camps[p.campId];
      const buff = world.data.jungle.buffs[camp?.def?.buff];
      ui.pushFeed(ui.t('hud_buff_gained', { name: ui.t(buff?.name_key ?? p.buffId) }), '#f0a63c');
      audio.buff();
    });
    e.on(EV.CAMP_CLEARED, () => audio.camp());
    e.on(EV.ABILITY_CAST, p => { if (world.byId.get(p.heroId)?.team === ui.playerTeam) audio.cast(p.slot); });
    e.on('cast_failed', p => { if (world.byId.get(p.heroId)?.team === ui.playerTeam) audio.deny(); });
    e.on('command_failed', p => {
      if (world.byId.get(p.heroId)?.team !== ui.playerTeam) return;
      audio.deny();
      const msg = { cant_afford: 'hud_cant_afford', slots_full: 'hud_slots_full', no_points: 'hud_no_points',
        max_rank: 'hud_max_rank', level_required: 'hud_level_required', dead: 'hud_dead' }[p.reason];
      ui.pushFeed(msg ? ui.t(msg) : `${p.command}: ${p.reason}`, '#ff5e6c');
    });
    e.on(EV.GAME_OVER, p => {
      ui.feed.length = 0;
      ui.pushFeed(p.winner === ui.playerTeam ? ui.t('hud_victory') : ui.t('hud_defeat'),
        p.winner === ui.playerTeam ? '#54d97a' : '#ff5e6c');
      audio.gameOver(p.winner === ui.playerTeam);
    });
    e.on(EV.UNIT_DIED, p => {
      if (p.kind === 'minion' && p.team !== ui.playerTeam && p.killerId === world.heroByTeam[ui.playerTeam]?.id) audio.lastHit();
    });
  }

  /* ---------------------------------------------------------- 输入 */
  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    view.w = window.innerWidth; view.h = window.innerHeight; view.dpr = dpr;
    canvas.width = Math.floor(view.w * dpr);
    canvas.height = Math.floor(view.h * dpr);
    canvas.style.width = view.w + 'px';
    canvas.style.height = view.h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  function cursorWorld(ev) {
    screenToWorld(view, ev.clientX, ev.clientY, WORLD_PT);
    ui.cursor.sx = ev.clientX; ui.cursor.sy = ev.clientY;
    ui.cursor.x = WORLD_PT.x; ui.cursor.y = WORLD_PT.y;
    return WORLD_PT;
  }

  canvas.addEventListener('pointermove', ev => {
    cursorWorld(ev);
    const c = data.map.camera;
    ui.edgePan.left = ev.clientX < c.edge_pan_px;
    ui.edgePan.right = ev.clientX > view.w - c.edge_pan_px;
    ui.edgePan.up = ev.clientY < c.edge_pan_px;
    ui.edgePan.down = ev.clientY > view.h - c.edge_pan_px;
  });

  canvas.addEventListener('contextmenu', ev => ev.preventDefault());

  canvas.addEventListener('pointerdown', ev => {
    audio.unlock();
    cursorWorld(ev);
    // HUD 热区优先
    for (const h of hotspots) {
      if (ev.clientX >= h.x && ev.clientX <= h.x + h.w && ev.clientY >= h.y && ev.clientY <= h.y + h.h) {
        handleHotspot(h, ev);
        return;
      }
    }
    if (world.over) return;
    const me = world.heroByTeam[ui.playerTeam];
    if (!me?.alive) return;
    const inp = input[ui.playerTeam];
    if (ev.button === 2) {                       // 右键：移动
      inp.move = { x: WORLD_PT.x, y: WORLD_PT.y };
      inp.attackMove = null; inp.attackTarget = 0;
      audio.move();
    } else if (ev.button === 0) {                // 左键：攻击移动 / 选目标
      if (ui.attackMoveArmed) {
        inp.attackMove = { x: WORLD_PT.x, y: WORLD_PT.y };
        inp.move = null; inp.attackTarget = 0;
        ui.attackMoveArmed = false;
        audio.attackMove();
        return;
      }
      const target = pickEnemyAt(WORLD_PT.x, WORLD_PT.y);
      if (target) { inp.attackTarget = target.id; inp.move = null; inp.attackMove = null; audio.select(); }
    }
  });

  function pickEnemyAt(wx, wy) {
    queryNear(world, wx, wy, 46, NEAR);
    let best = null, bestD = Infinity;
    const me = world.heroByTeam[ui.playerTeam];
    for (const t of NEAR) {
      if (!t.alive || t.team === me.team || t.team === 'neutral') continue;
      if (t.kind === 'structure' && t.invulnerable) continue;
      const d = dist2(wx, wy, t.x, t.y);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  canvas.addEventListener('wheel', ev => {
    ev.preventDefault();
    const c = data.map.camera;
    ui.camera.targetZoom = clamp(ui.camera.targetZoom * (ev.deltaY > 0 ? 0.9 : 1.1), c.zoom_min, c.zoom_max);
  }, { passive: false });

  function handleHotspot(h, ev) {
    const me = world.heroByTeam[ui.playerTeam];
    const inp = input[ui.playerTeam];
    switch (h.action.type) {
      case 'buy': inp.buy = h.action.itemId; audio.click(); break;
      case 'sell': inp.sell = h.action.slot; audio.click(); break;
      case 'rankUp': inp.rankUp = h.action.slot; audio.click(); break;
      case 'toggleShop': ui.shopOpen = !ui.shopOpen; audio.click(); break;
      case 'toggleSettings': ui.settingsOpen = !ui.settingsOpen; ui.rebinding = null; audio.click(); break;
      case 'cycleScale': ui.setPref('scale', ui.scale >= 1.5 ? 1.0 : ui.scale + 0.25); audio.click(); break;
      case 'toggleColorblind': ui.setPref('colorblind', !ui.colorblind); audio.click(); break;
      case 'toggleMute': ui.setPref('muted', !ui.muted); audio.click(); break;
      case 'toggleRanges': ui.setPref('showRanges', !ui.showRanges); audio.click(); break;
      case 'rebind': ui.rebinding = ui.rebinding === h.action.action ? null : h.action.action; audio.click(); break;
      case 'restart': newGame(); audio.click(); break;
      default: break;
    }
    void ev; void me;
  }

  window.addEventListener('keydown', ev => {
    audio.unlock();
    const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    if (ui.rebinding) {
      ui.bindKey(ui.rebinding, ev.key.length === 1 ? ev.key.toLowerCase() : ev.key);
      ui.rebinding = null;
      ev.preventDefault();
      return;
    }
    ui.keysDown.add(key);
    const kb = ui.keybinds;
    const me = world.heroByTeam[ui.playerTeam];
    const inp = input[ui.playerTeam];
    if (key === kb.q || key === kb.w || key === kb.e || key === kb.r) {
      const slot = Object.keys(kb).find(a => kb[a] === key && ['q', 'w', 'e', 'r'].includes(a));
      if (slot && me?.alive && !world.over) {
        const ability = data.abilities.abilities[me.def.abilities[slot]];
        let targetId = 0;
        if (ability?.targeting === 'unit') {
          const t = pickEnemyAt(ui.cursor.x, ui.cursor.y) ?? nearestEnemyHero(me, ability.range || 700);
          targetId = t?.id ?? 0;
        }
        inp.casts.push({ slot, x: ui.cursor.x, y: ui.cursor.y, targetId });
      }
      ev.preventDefault();
      return;
    }
    if (key === kb.attackMove) { ui.attackMoveArmed = true; return; }
    if (key === kb.shop) { ui.shopOpen = !ui.shopOpen; audio.click(); ev.preventDefault(); return; }
    if (key === kb.camera) { hookCamera(); ev.preventDefault(); return; }
    if (key === kb.mute) { ui.setPref('muted', !ui.muted); return; }
    if (key === kb.debug) { ui.debug = !ui.debug; return; }
    if (key === 'Escape') { ui.shopOpen = false; ui.settingsOpen = false; ui.rebinding = null; ui.attackMoveArmed = false; return; }
    if (key === kb.restart && world.over) { newGame(); return; }
    if (['1', '2', '3', '4'].includes(key) && me?.alive) {
      // 不在这里判断"有没有技能点"：一律交给模拟校验，失败时由 command_failed
      // 给出"没有可用技能点/等级不足"的文字反馈 —— 按了没反应是最差的体验。
      inp.rankUp = SLOTS[Number(key) - 1];
      audio.click();
      ev.preventDefault();
    }
  });
  window.addEventListener('keyup', ev => {
    const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    ui.keysDown.delete(key);
    if (key === ui.keybinds.attackMove) ui.attackMoveArmed = false;
  });

  const SLOTS = ['q', 'w', 'e', 'r'];
  function nearestEnemyHero(me, radius) {
    let best = null, bestD = Infinity;
    for (const h of world.heroes) {
      if (h.team === me.team || !h.alive) continue;
      const d = dist2(me.x, me.y, h.x, h.y);
      if (d < radius * radius && d < bestD) { bestD = d; best = h; }
    }
    return best;
  }

  /* ---------------------------------------------------------- 主循环 */
  let last = performance.now();
  let acc = 0;
  let fpsAcc = 0, fpsFrames = 0;

  // 失败可见性（用户实测教训：浏览器里第一帧抛异常时，status 已被清空，
  // 页面只剩一块黑画布、没有任何线索。现在任何一帧抛异常都会画在屏幕上。）
  let fatal = null;
  let framesDrawn = 0;
  const DIAG = typeof location !== 'undefined' && /[?&]diag=1/.test(location.search);

  function drawFatal(err) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#070910';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ff5e6c';
    ctx.font = '700 20px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText('RIFTLANE 运行出错（请把这段文字反馈给开发）', 24, 40);
    ctx.font = '400 14px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = '#e8ecf6';
    const lines = String(err?.stack || err?.message || err).split('\n').slice(0, 10);
    lines.forEach((ln, i) => ctx.fillText(ln.slice(0, 150), 24, 72 + i * 20));
    ctx.fillStyle = '#5f6a80';
    ctx.fillText(`canvas=${canvas.width}x${canvas.height} inner=${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio}`, 24, 72 + lines.length * 20 + 16);
  }

  function diagOverlay() {
    const me = world?.heroByTeam?.[ui.playerTeam];
    ctx.setTransform(view.dpr || 1, 0, 0, view.dpr || 1, 0, 0);
    ctx.fillStyle = 'rgba(7,9,16,0.82)';
    ctx.fillRect(8, 8, 468, 132);
    ctx.fillStyle = '#7ef0d8';
    ctx.font = '400 12px ui-monospace, Menlo, Consolas, monospace';
    const rows = [
      `frames=${framesDrawn} fps=${(ui.fps || 0).toFixed(0)} zoom=${view.zoom?.toFixed(3)} cam=${view.camX?.toFixed(0)},${view.camY?.toFixed(0)}`,
      `canvas=${canvas.width}x${canvas.height} css=${view.w}x${view.h} dpr=${view.dpr}`,
      `ents=${world?.entities?.length ?? '-'} minions=${world?.entities?.filter(e => e.kind === 'minion' && e.alive).length ?? '-'} t=${world?.time?.toFixed(0)}s`,
      `hero=${me ? Math.round(me.x) + ',' + Math.round(me.y) + ' hp' + Math.round(me.health) : '-'} over=${world?.over}`,
      `fatal=${fatal ? fatal.message : 'none'}`
    ];
    rows.forEach((r, i) => ctx.fillText(r, 16, 26 + i * 20));
  }

  function frame(now) {
    if (fatal) { drawFatal(fatal); requestAnimationFrame(frame); return; }
    try {
    const rawDt = Math.min(MAX_FRAME_DT, (now - last) / 1000);
    last = now;
    acc += rawDt;

    // 固定步长推进模拟（确定性）
    let ticks = 0;
    const t0 = performance.now();
    while (acc >= FIXED_DT && ticks < 6) {
      acc -= FIXED_DT;
      ui.update(FIXED_DT);
      input.dire = updateHeroAi(world, ai, FIXED_DT);
      tick(world, input);
      // 每 tick 重置玩家命令中的一次性字段（casts/buy/sell/rankUp）
      input.radiant.casts.length = 0;
      input.radiant.buy = null; input.radiant.sell = -1; input.radiant.rankUp = null;
      ticks++;
    }
    const tickUs = (performance.now() - t0) * 1000 / Math.max(1, ticks);
    world.perf.lastTickUs = tickUs;
    if (tickUs > FRAME_BUDGET_MS * 1000) world.perf.warnCount++;   // enforce: warn

    // 镜头
    updateCamera(rawDt);

    // 渲染
    const r0 = performance.now();
    view.zoom = damp(view.zoom, ui.camera.targetZoom, 12, rawDt);
    buildWorldDrawList(world, view, ui, drawList);
    buildHudDrawList(world, view, ui, hudList, hotspots);
    renderDrawList(ctx, drawList, view);
    renderDrawList(ctx, hudList, view);
    ui.lastRenderMs = performance.now() - r0;
    ui.aiDebug = ui.debug ? debugAi(ai, world) : null;

    fpsAcc += rawDt; fpsFrames++;
    if (fpsAcc >= 0.5) { ui.fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }
    // performance.enforce: warn
    if (ui.fps < FPS_TARGET * 0.75 && ui.debug) {
      console.warn(`[perf] fps ${ui.fps.toFixed(1)} below target ${FPS_TARGET}`);
    }
    } catch (err) {
      fatal = err;
      console.error('[frame]', err);
      drawFatal(err);
      requestAnimationFrame(frame);
      return;
    }
    framesDrawn++;
    if (framesDrawn === 1) {                       // 第一帧真的画出来了才收掉加载提示
      const st = document.getElementById('status');
      if (st) st.textContent = '';
    }
    if (DIAG) diagOverlay();
    requestAnimationFrame(frame);
  }

  // 首帧看门狗：6 秒还画不出第一帧，把环境信息直接写在页面上（不再静默黑屏）
  setTimeout(() => {
    if (framesDrawn === 0 && !fatal) {
      const st = document.getElementById('status');
      if (st) {
        st.innerHTML = '<span class="t" style="color:#ff5e6c">6 秒仍画不出第一帧</span>'
          + `canvas=${canvas.width}x${canvas.height} inner=${window.innerWidth}x${window.innerHeight}`
          + ` dpr=${window.devicePixelRatio}<span class="k">rAF=${typeof requestAnimationFrame} · `
          + `modules loaded · 请在地址后加 ?diag=1 重试并反馈屏幕文字</span>`;
      }
    }
  }, 6000);
  if (typeof window !== 'undefined') {
    window.addEventListener('error', ev => { if (!fatal) { fatal = ev.error || new Error(ev.message); drawFatal(fatal); } });
    window.addEventListener('unhandledrejection', ev => { if (!fatal) { fatal = new Error(String(ev.reason)); drawFatal(fatal); } });
  }

  function updateCamera(dt) {
    const me = world.heroByTeam[ui.playerTeam];
    const c = data.map.camera;
    let tx = me ? me.x : view.camX, ty = me ? me.y : view.camY;
    const pan = c.edge_pan_speed * dt / view.zoom;
    if (ui.edgePan.left || ui.keysDown.has('arrowleft')) tx -= pan;
    if (ui.edgePan.right || ui.keysDown.has('arrowright')) tx += pan;
    if (ui.edgePan.up || ui.keysDown.has('arrowup')) ty -= pan;
    if (ui.edgePan.down || ui.keysDown.has('arrowdown')) ty += pan;
    view.camX = damp(view.camX, tx, c.follow_lerp, dt);
    view.camY = damp(view.camY, ty, c.follow_lerp, dt);
    const halfW = view.w / 2 / view.zoom, halfH = view.h / 2 / view.zoom;
    view.camX = clamp(view.camX, halfW * 0.35, data.map.world.width - halfW * 0.35);
    view.camY = clamp(view.camY, halfH * 0.35, data.map.world.height - halfH * 0.35);
  }

  newGame();
  requestAnimationFrame(frame);
  // rAF 兜底：部分嵌入预览环境（后台 iframe / 受限 webview）会节流甚至不触发 rAF，
  // 表现就是"页面全黑、什么都没有"。第一帧画出来之前用 setInterval 驱动，画出来即停。
  const fallbackDriver = setInterval(() => {
    if (framesDrawn > 0 || fatal) { clearInterval(fallbackDriver); return; }
    frame(performance.now());
  }, 16);

  // 开发期句柄：便于在控制台里检查模拟（不参与游戏逻辑）
  window.__riftlane = {
    get world() { return world; }, ui, view, data, tick, worldToScreen,
    get framesDrawn() { return framesDrawn; }, get fatal() { return fatal; }
  };
}

boot().catch(err => {
  console.error(err);
  const el = document.getElementById('status');
  if (el) { el.textContent = '启动失败：' + (err?.message || err); el.style.color = '#ff5e6c'; }
});
