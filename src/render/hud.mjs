/**
 * src/render/hud.js — HUD 层：模拟状态 → 绘制指令 + 可点击热区。
 *
 * .claude/rules/ui-code.md：UI 不得持有游戏状态。本模块只读 world 与 ui 状态，
 * 输出绘制指令与热区（hotspots），由 main.mjs 把点击翻译回 input_state 交给模拟。
 * 所有文案走 ui.t(key)（本地化就绪，无硬编码字符串）。
 */
import { paletteFor, teamColor } from './palette.mjs';
import { formatClock, clamp } from '../core/math.mjs';
import { campStatus } from '../gameplay/objectives.mjs';

const SLOTS = ['q', 'w', 'e', 'r'];

export function buildHudDrawList(world, view, ui, out, hotspots) {
  out.length = 0; hotspots.length = 0;
  const P = paletteFor(ui);
  const s = ui.scale;
  const me = world.heroByTeam[ui.playerTeam];
  const foe = world.heroes.find(h => h.team !== ui.playerTeam);

  topBar(world, view, ui, P, s, out);
  killFeed(ui, P, s, out, view);
  campPanel(world, view, ui, P, s, out, hotspots);
  if (me) heroPanel(world, view, ui, P, s, out, hotspots, me);
  minimap(world, view, ui, P, s, out);
  hints(ui, P, s, out, view);
  if (ui.shopOpen) shopPanel(world, view, ui, P, s, out, hotspots, me);
  if (ui.settingsOpen) settingsPanel(world, view, ui, P, s, out, hotspots);
  if (me && !me.alive) respawnOverlay(world, view, ui, P, s, out, me);
  if (world.over) gameOver(world, view, ui, P, s, out, hotspots);
  if (ui.debug) debugOverlay(world, view, ui, P, s, out);
  return out;
}

function panel(out, x, y, w, h, P, alpha = 0.9) {
  out.push({ op: 'rrect', x, y, w, h, r: 8, color: P.panel, fill: true, alpha, stroke: P.panelEdge, lineWidth: 1 });
}
function text(out, x, y, str, size, color, align = 'left', bold = false, baseline = 'alphabetic') {
  out.push({ op: 'text', x, y, text: str, size, color, align, bold, baseline, shadow: true });
}
function hot(hotspots, id, x, y, w, h, action) { hotspots.push({ id, x, y, w, h, action }); }

/* ---------------------------------------------------------------- 顶部计分板 */
function topBar(world, view, ui, P, s, out) {
  const w = 340 * s, h = 44 * s;
  const x = view.w / 2 - w / 2, y = 10;
  panel(out, x, y, w, h, P);
  const me = world.heroByTeam[ui.playerTeam];
  const foe = world.heroes.find(h => h.team !== ui.playerTeam);
  text(out, view.w / 2, y + 20 * s, formatClock(world.time), 20 * s, P.text, 'center', true);
  // 左：我方
  text(out, x + 14 * s, y + 20 * s, String(me?.kills ?? 0), 18 * s, teamColor(P, ui.playerTeam), 'left', true);
  text(out, x + 14 * s, y + 36 * s, `${ui.t('hud_cs')} ${me?.cs ?? 0}`, 11 * s, P.textDim);
  // 右：敌方
  text(out, x + w - 14 * s, y + 20 * s, String(foe?.kills ?? 0), 18 * s, teamColor(P, foe?.team), 'right', true);
  text(out, x + w - 14 * s, y + 36 * s, `${ui.t('hud_cs')} ${foe?.cs ?? 0}`, 11 * s, P.textDim, 'right');
  // 建筑存活数
  const rad = world.entities.filter(e => e.kind === 'structure' && e.team === ui.playerTeam && e.alive).length;
  const dire = world.entities.filter(e => e.kind === 'structure' && e.team !== ui.playerTeam && e.alive).length;
  text(out, view.w / 2 - 62 * s, y + 37 * s, `◆${rad}`, 11 * s, P.textDim, 'center');
  text(out, view.w / 2 + 62 * s, y + 37 * s, `◆${dire}`, 11 * s, P.textDim, 'center');
}

/* ---------------------------------------------------------------- 击杀提示流 */
function killFeed(ui, P, s, out, view) {
  const x = 14, yTop = 12;
  for (let i = 0; i < ui.feed.length; i++) {
    const f = ui.feed[i];
    const a = clamp(f.life / f.maxLife, 0, 1);
    const w = 268 * s, h = 22 * s;
    const y = yTop + i * (h + 4);
    out.push({ op: 'rrect', x, y, w, h, r: 6, color: P.panel, fill: true, alpha: 0.78 * a, stroke: P.panelEdge, lineWidth: 1 });
    text(out, x + 10 * s, y + 15 * s, f.text, 12 * s, f.color || P.text, 'left', false);
    out[out.length - 1].alpha = a;
  }
  void view;
}

/* ---------------------------------------------------------------- 野区计时 */
function campPanel(world, view, ui, P, s, out, hotspots) {
  const ids = Object.keys(world.camps);
  const w = 176 * s, h = 26 * s * ids.length + 30 * s;
  const x = view.w - w - 14, y = 12;
  panel(out, x, y, w, h, P, 0.82);
  ids.forEach((id, i) => {
    const camp = world.camps[id];
    const st = campStatus(world, id);
    const yy = y + 20 * s + i * 26 * s;
    const label = ui.t(camp.def.name_key);
    const col = st.state === 'alive' ? P.neutral : P.textFaint;
    out.push({ op: 'circle', x: x + 12 * s, y: yy - 4 * s, r: 4 * s, color: col });
    text(out, x + 22 * s, yy, label.length > 9 ? label.slice(0, 9) : label, 11 * s, st.state === 'alive' ? P.text : P.textDim);
    const right = st.state === 'alive' ? '✓' : `${Math.ceil(st.remaining)}s`;
    text(out, x + w - 10 * s, yy, right, 11 * s, st.state === 'alive' ? P.ok : P.textFaint, 'right');
  });
  // 设置按钮
  const bx = x, by = y + h + 8, bw = w, bh = 26 * s;
  out.push({ op: 'rrect', x: bx, y: by, w: bw, h: bh, r: 6, color: ui.settingsOpen ? P.panelHi : P.panel, fill: true, stroke: P.panelEdge, lineWidth: 1 });
  text(out, bx + bw / 2, by + 17 * s, ui.t('hud_settings_title'), 12 * s, P.textDim, 'center');
  hot(hotspots, 'settings', bx, by, bw, bh, { type: 'toggleSettings' });
}

/* ---------------------------------------------------------------- 英雄面板 */
function heroPanel(world, view, ui, P, s, out, hotspots, me) {
  const abW = 52 * s, gap = 6 * s;
  const w = 560 * s, h = 104 * s;
  const x = view.w / 2 - w / 2, y = view.h - h - 12;
  panel(out, x, y, w, h, P, 0.94);

  // 生命/法力条
  const barX = x + 14 * s, barW = 250 * s;
  const hpPct = clamp(me.health / me.stats.max_health, 0, 1);
  const mpPct = clamp(me.mana / Math.max(1, me.stats.max_mana), 0, 1);
  out.push({ op: 'rect', x: barX, y: y + 14 * s, w: barW, h: 15 * s, color: '#05070c', fill: true });
  out.push({ op: 'rect', x: barX, y: y + 14 * s, w: barW * hpPct, h: 15 * s, color: P.health, fill: true });
  text(out, barX + barW / 2, y + 26 * s, `${Math.ceil(me.health)} / ${Math.round(me.stats.max_health)}`, 11 * s, P.text, 'center', true);
  out.push({ op: 'rect', x: barX, y: y + 32 * s, w: barW, h: 9 * s, color: '#05070c', fill: true });
  out.push({ op: 'rect', x: barX, y: y + 32 * s, w: barW * mpPct, h: 9 * s, color: P.mana, fill: true });
  text(out, barX + barW / 2, y + 40 * s, `${Math.floor(me.mana)} / ${Math.round(me.stats.max_mana)}`, 9 * s, P.textDim, 'center');

  // 经验条 + 等级
  const xpNeed = me.level >= world.data.progression.level_max ? 1 : me.xp / (world.data.progression.xp_to_next[me.level - 1] || 1);
  out.push({ op: 'rect', x: barX, y: y + 45 * s, w: barW, h: 4 * s, color: '#05070c', fill: true });
  out.push({ op: 'rect', x: barX, y: y + 45 * s, w: barW * clamp(xpNeed, 0, 1), h: 4 * s, color: P.xp, fill: true });
  text(out, barX, y + 66 * s, `${ui.t('hud_level')} ${me.level}`, 13 * s, P.xp, 'left', true);
  text(out, barX + 96 * s, y + 66 * s, `${ui.t('hud_gold')} ${Math.floor(me.gold)}`, 13 * s, P.gold, 'left', true);
  text(out, barX + 210 * s, y + 66 * s, `${ui.t('hud_kda')} ${me.kills}/${me.deaths}`, 12 * s, P.textDim);
  text(out, barX, y + 84 * s, `${ui.t('hud_cs')} ${me.cs}`, 12 * s, P.textDim);
  if (me.skillPoints > 0) text(out, barX + 96 * s, y + 84 * s, `▲ ${ui.t('hud_skill_points')}`, 12 * s, P.xp, 'left', true);

  // 技能图标
  const abY = y + 14 * s;
  SLOTS.forEach((slot, i) => {
    const bx = x + 288 * s + i * (abW + gap);
    const abilityId = me.def.abilities[slot];
    const ability = world.data.abilities.abilities[abilityId];
    const rank = me.skillLevels[slot] || 0;
    const cd = me.cooldowns[slot] || 0;
    const usable = rank > 0 && cd <= 0 && me.mana >= (ability?.cost?.[rank - 1] ?? 0);
    out.push({ op: 'rrect', x: bx, y: abY, w: abW, h: abW, r: 7, color: rank > 0 ? P.panelHi : '#0d1220', fill: true, stroke: usable ? teamColor(P, ui.playerTeam) : P.panelEdge, lineWidth: usable ? 2 : 1 });
    if (rank > 0) {
      out.push({ op: 'circle', x: bx + abW / 2, y: abY + abW / 2 - 4 * s, r: 13 * s, color: usable ? teamColor(P, ui.playerTeam) : P.textFaint, alpha: usable ? 0.85 : 0.4, glow: usable ? 14 : 0 });
    }
    text(out, bx + abW / 2, abY + abW / 2 + 1 * s, slot.toUpperCase(), 16 * s, rank > 0 ? '#08111a' : P.textFaint, 'center', true);
    // 冷却遮罩（自下而上的暗色覆盖 + 秒数）
    if (cd > 0) {
      const pctf = clamp(cd / Math.max(0.001, abilityCooldownTotal(world, me, slot, ability, rank)), 0, 1);
      out.push({ op: 'rect', x: bx, y: abY + abW * (1 - pctf), w: abW, h: abW * pctf, color: P.cooldown, fill: true });
      text(out, bx + abW / 2, abY + abW / 2 + 4 * s, cd.toFixed(1), 13 * s, P.text, 'center', true);
    }
    // 等级点
    const maxRank = ability?.rank_max ?? 5;
    for (let k = 0; k < maxRank; k++) {
      out.push({ op: 'circle', x: bx + 8 * s + k * 8 * s, y: abY + abW - 7 * s, r: 2.4 * s, color: k < rank ? P.xp : P.textFaint, alpha: k < rank ? 1 : 0.5 });
    }
    // 键位（可重映射）
    text(out, bx + abW - 6 * s, abY + 12 * s, ui.keyLabel(slot), 10 * s, P.textDim, 'right');
    if (me.skillPoints > 0 && rank < maxRank && canRankNow(world, me, slot)) {
      out.push({ op: 'rrect', x: bx, y: abY, w: abW, h: abW, r: 7, color: 'transparent', fill: false, stroke: P.xp, lineWidth: 2 });
      text(out, bx + abW / 2, abY - 5 * s, '+', 15 * s, P.xp, 'center', true);
      hot(hotspots, 'rank_' + slot, bx, abY - 8 * s, abW, abW + 8 * s, { type: 'rankUp', slot });
    }
    // 法力消耗
    if (rank > 0) text(out, bx + abW / 2, abY + abW + 12 * s, String(ability?.cost?.[rank - 1] ?? ''), 10 * s, P.mana, 'center');
  });

  // 装备栏
  const itX = x + 288 * s, itY = abY + abW + 20 * s;
  const slot = 30 * s;
  for (let i = 0; i < world.data.progression.item_slots; i++) {
    const bx = itX + i * (slot + 4 * s);
    const id = me.items[i];
    out.push({ op: 'rrect', x: bx, y: itY, w: slot, h: slot, r: 5, color: id ? P.panelHi : '#0d1220', fill: true, stroke: id ? P.gold : P.panelEdge, lineWidth: 1 });
    if (id) {
      const item = world.data.items.items[id];
      text(out, bx + slot / 2, itY + slot / 2 + 4 * s, (ui.t(item.name_key) || id).slice(0, 2), 11 * s, P.gold, 'center', true);
      hot(hotspots, 'sell_' + i, bx, itY, slot, slot, { type: 'sell', slot: i });
    }
  }
  text(out, itX + 6 * (slot + 4 * s) + 6 * s, itY + slot / 2 + 4 * s,
    ui.t('hud_shop_slots', { used: me.items.length, max: world.data.progression.item_slots }), 11 * s, P.textDim);
  text(out, itX, itY - 6 * s, `${ui.t('hud_shop_hint')}`, 10.5 * s, P.textFaint);
}

function abilityCooldownTotal(world, me, slot, ability, rank) {
  const base = ability?.cooldown?.[Math.max(0, rank - 1)] ?? 0;
  return base * (1 - me.stats.cooldown_reduction_pct) || base || 1;
}
function canRankNow(world, me, slot) {
  const ability = world.data.abilities.abilities[me.def.abilities[slot]];
  if (!ability) return false;
  const cur = me.skillLevels[slot] || 0;
  return me.level >= (ability.required_level || 1) + cur * 5;
}

/* ---------------------------------------------------------------- 商店 */
function shopPanel(world, view, ui, P, s, out, hotspots, me) {
  const items = Object.entries(world.data.items.items);
  const w = 330 * s, rowH = 34 * s, h = 62 * s + items.length * rowH;
  const x = view.w - w - 14, y = view.h / 2 - h / 2;
  panel(out, x, y, w, h, P, 0.97);
  text(out, x + 14 * s, y + 24 * s, ui.t('hud_shop_title'), 17 * s, P.gold, 'left', true);
  text(out, x + w - 14 * s, y + 24 * s, `${ui.t('hud_gold')} ${Math.floor(me?.gold ?? 0)}`, 13 * s, P.text, 'right', true);
  text(out, x + 14 * s, y + 44 * s, ui.t('hud_shop_close'), 11 * s, P.textDim);
  hot(hotspots, 'shop_close', x + w - 90 * s, y + 8 * s, 84 * s, 22 * s, { type: 'toggleShop' });

  items.forEach(([id, item], i) => {
    const ry = y + 54 * s + i * rowH;
    const afford = (me?.gold ?? 0) >= item.cost;
    const owned = me?.items.includes(id);
    const full = (me?.items.length ?? 0) >= world.data.progression.item_slots;
    out.push({ op: 'rrect', x: x + 10 * s, y: ry, w: w - 20 * s, h: rowH - 4 * s, r: 6, color: owned ? '#101a12' : P.panelHi, fill: true, alpha: afford || owned ? 1 : 0.55, stroke: owned ? P.ok : (afford && !full ? P.panelEdge : '#1a2130'), lineWidth: 1 });
    text(out, x + 20 * s, ry + 14 * s, ui.t(item.name_key), 12.5 * s, owned ? P.ok : P.text, 'left', true);
    text(out, x + 20 * s, ry + 26 * s, ui.t(item.desc_key), 10 * s, P.textDim);
    if (!owned) {
      text(out, x + w - 20 * s, ry + 18 * s, `${item.cost}g`, 12 * s, afford ? P.gold : P.danger, 'right', true);
      hot(hotspots, 'buy_' + id, x + 10 * s, ry, w - 20 * s, rowH - 4 * s, { type: 'buy', itemId: id });
    } else {
      text(out, x + w - 20 * s, ry + 18 * s, ui.t('hud_shop_sell'), 11 * s, P.ok, 'right');
    }
  });
}

/* ---------------------------------------------------------------- 设置 */
function settingsPanel(world, view, ui, P, s, out, hotspots) {
  const w = 330 * s, h = 232 * s;
  const x = view.w - w - 14, y = 120;
  panel(out, x, y, w, h, P, 0.97);
  text(out, x + 14 * s, y + 24 * s, ui.t('hud_settings_title'), 16 * s, P.text, 'left', true);
  const rows = [
    { key: 'scale', label: ui.t('hud_ui_scale'), value: `${ui.scale.toFixed(2)}×`, action: { type: 'cycleScale' } },
    { key: 'cb', label: ui.t('hud_colorblind'), value: ui.colorblind ? 'ON' : 'OFF', action: { type: 'toggleColorblind' } },
    { key: 'mute', label: ui.t('hud_mute'), value: ui.muted ? 'ON' : 'OFF', action: { type: 'toggleMute' } },
    { key: 'ranges', label: 'Attack range', value: ui.showRanges ? 'ON' : 'OFF', action: { type: 'toggleRanges' } }
  ];
  rows.forEach((r, i) => {
    const ry = y + 40 * s + i * 30 * s;
    out.push({ op: 'rrect', x: x + 10 * s, y: ry, w: w - 20 * s, h: 26 * s, r: 6, color: P.panelHi, fill: true, stroke: P.panelEdge, lineWidth: 1 });
    text(out, x + 20 * s, ry + 18 * s, r.label, 12 * s, P.text);
    text(out, x + w - 20 * s, ry + 18 * s, r.value, 12 * s, P.xp, 'right', true);
    hot(hotspots, 'set_' + r.key, x + 10 * s, ry, w - 20 * s, 26 * s, r.action);
  });
  // 键位重映射（story-007 无障碍：按键可重映射并在 HUD 显示当前键位）
  const by = y + 40 * s + rows.length * 30 * s + 4 * s;
  text(out, x + 14 * s, by + 12 * s, ui.t('hud_rebind_hint'), 10.5 * s, P.textDim);
  const binds = ['move', 'attackMove', 'q', 'w', 'e', 'r', 'shop', 'camera'];
  binds.forEach((b, i) => {
    const bx = x + 12 * s + (i % 4) * 78 * s;
    const bry = by + 20 * s + Math.floor(i / 4) * 30 * s;
    out.push({ op: 'rrect', x: bx, y: bry, w: 72 * s, h: 26 * s, r: 6, color: ui.rebinding === b ? P.panelHi : '#0d1220', fill: true, stroke: ui.rebinding === b ? P.xp : P.panelEdge, lineWidth: 1 });
    text(out, bx + 6 * s, bry + 17 * s, b.length > 6 ? b.slice(0, 6) : b, 10 * s, P.textDim);
    text(out, bx + 68 * s, bry + 17 * s, ui.rebinding === b ? '...' : ui.keyLabel(b), 11 * s, P.xp, 'right', true);
    hot(hotspots, 'bind_' + b, bx, bry, 72 * s, 26 * s, { type: 'rebind', action: b });
  });
}

/* ---------------------------------------------------------------- 小地图 */
function minimap(world, view, ui, P, s, out) {
  const w = 216 * s, h = 84 * s;
  const x = view.w - w - 14, y = view.h - h - 12;
  panel(out, x, y, w, h, P, 0.9);
  const W = world.data.map.world.width, H = world.data.map.world.height;
  const mx = wx => x + 8 * s + (wx / W) * (w - 16 * s);
  const my = wy => y + 8 * s + (wy / H) * (h - 16 * s);
  const path = world.data.map.lane_path;
  for (let i = 1; i < path.length; i++) {
    out.push({ op: 'line', x1: mx(path[i - 1][0]), y1: my(path[i - 1][1]), x2: mx(path[i][0]), y2: my(path[i][1]), color: P.laneEdge, width: 6 * s });
  }
  for (const e of world.entities) {
    if (!e.alive) continue;
    const col = teamColor(P, e.team);
    if (e.kind === 'structure') out.push({ op: 'rect', x: mx(e.x) - 3 * s, y: my(e.y) - 3 * s, w: 6 * s, h: 6 * s, color: e.invulnerable ? P.textFaint : col, fill: true });
    else if (e.kind === 'hero') out.push({ op: 'circle', x: mx(e.x), y: my(e.y), r: 4 * s, color: col, stroke: '#fff', lineWidth: 1 });
    else out.push({ op: 'circle', x: mx(e.x), y: my(e.y), r: 1.8 * s, color: col, alpha: 0.9 });
  }
  // 视野框
  const vw = (view.w / view.zoom) / W * (w - 16 * s), vh = (view.h / view.zoom) / H * (h - 16 * s);
  out.push({ op: 'rect', x: mx(view.camX) - vw / 2, y: my(view.camY) - vh / 2, w: vw, h: vh, color: 'transparent', fill: false, stroke: P.textDim, lineWidth: 1 });
}

/* ---------------------------------------------------------------- 提示与覆盖层 */
function hints(ui, P, s, out, view) {
  text(out, 14, view.h - 16, ui.t('hud_shop_hint'), 11 * s, P.textFaint);
  text(out, 14, view.h - 34, ui.t('shape_legend'), 10.5 * s, P.textFaint);
}

function respawnOverlay(world, view, ui, P, s, out, me) {
  const remain = Math.max(0, me.respawnAt - world.time);
  out.push({ op: 'rect', x: 0, y: 0, w: view.w, h: view.h, color: '#000000', fill: true, alpha: 0.42 });
  text(out, view.w / 2, view.h / 2 - 10, ui.t('hud_respawn_in', { sec: Math.ceil(remain) }), 30 * s, P.danger, 'center', true);
  text(out, view.w / 2, view.h / 2 + 22 * s, `${ui.t('hud_level')} ${me.level}`, 14 * s, P.textDim, 'center');
}

function gameOver(world, view, ui, P, s, out, hotspots) {
  out.push({ op: 'rect', x: 0, y: 0, w: view.w, h: view.h, color: '#05070c', fill: true, alpha: 0.78 });
  const win = world.winner === ui.playerTeam;
  const w = 460 * s, h = 300 * s, x = view.w / 2 - w / 2, y = view.h / 2 - h / 2;
  panel(out, x, y, w, h, P, 0.98);
  text(out, view.w / 2, y + 52 * s, win ? ui.t('hud_victory') : ui.t('hud_defeat'), 40 * s, win ? P.ok : P.danger, 'center', true);
  text(out, view.w / 2, y + 78 * s, win ? ui.t('hud_victory_reason') : ui.t('hud_defeat_reason'), 13 * s, P.textDim, 'center');
  const me = world.heroByTeam[ui.playerTeam];
  const foe = world.heroes.find(h => h.team !== ui.playerTeam);
  const rows = [
    [ui.t('hud_stats_time'), formatClock(world.time), ''],
    [ui.t('hud_stats_kills'), String(me.kills), String(foe.kills)],
    [ui.t('hud_stats_deaths'), String(me.deaths), String(foe.deaths)],
    [ui.t('hud_stats_cs'), String(me.cs), String(foe.cs)],
    [ui.t('hud_stats_gold'), String(Math.floor(me.goldEarned)), String(Math.floor(foe.goldEarned))],
    [ui.t('hud_stats_towers'), String(world.teamState[ui.playerTeam].structuresDestroyed), String(world.teamState[foe.team].structuresDestroyed)]
  ];
  text(out, x + w - 60 * s, y + 104 * s, ui.t('team_dire'), 11 * s, teamColor(P, foe.team), 'right', true);
  rows.forEach((r, i) => {
    const ry = y + 122 * s + i * 24 * s;
    text(out, x + 24 * s, ry, r[0], 12 * s, P.textDim);
    text(out, x + w / 2 + 20 * s, ry, r[1], 13 * s, P.text, 'right', true);
    text(out, x + w - 24 * s, ry, r[2], 13 * s, P.text, 'right', true);
  });
  text(out, x + w / 2 + 20 * s, y + 104 * s, ui.t('team_radiant'), 11 * s, teamColor(P, ui.playerTeam), 'right', true);
  const bx = view.w / 2 - 90 * s, by = y + h - 46 * s;
  out.push({ op: 'rrect', x: bx, y: by, w: 180 * s, h: 32 * s, r: 8, color: P.panelHi, fill: true, stroke: P.xp, lineWidth: 2 });
  text(out, view.w / 2, by + 21 * s, ui.t('hud_restart'), 14 * s, P.xp, 'center', true);
  hot(hotspots, 'restart', bx, by, 180 * s, 32 * s, { type: 'restart' });
}

function debugOverlay(world, view, ui, P, s, out) {
  const lines = [
    `tick ${world.tickCount}  t=${world.time.toFixed(2)}s  ents=${world.entities.length}`,
    `proj=${world.projectiles.length} fx=${world.effects.length} part=${world.particles.length} txt=${world.floatTexts.length}`,
    `tick=${world.perf.lastTickUs.toFixed(0)}µs  render=${ui.lastRenderMs?.toFixed?.(1) ?? 0}ms  fps=${ui.fps?.toFixed?.(0) ?? 0}`,
    `pool particles ${JSON.stringify(world.fx.particles.stats())}`,
    ui.aiDebug ? `ai: ${JSON.stringify(ui.aiDebug)}` : ''
  ];
  lines.forEach((l, i) => { if (l) text(out, 14, 74 + i * 15 * s, l, 11 * s, P.textDim); });
}
