/**
 * src/ui/ui_state.js — UI 状态、本地化、键位映射、击杀提示流。
 *
 * .claude/rules/ui-code.md：UI 不持有游戏状态。这里只有"呈现与偏好"：
 * 镜头、面板开关、字号、色盲开关、静音、键位、提示流。
 * 本地化就绪：所有文案经 t(key) 从 assets/data/ui_strings.json 取，UI 代码零硬编码文案。
 */
export const DEFAULT_KEYBINDS = Object.freeze({
  move: 'Mouse2',            // 右键移动
  attack: 'Mouse1',          // 左键选中/攻击目标
  attackMove: 'a',
  q: 'q', w: 'w', e: 'e', r: 'r',
  rankUp1: '1', rankUp2: '2', rankUp3: '3', rankUp4: '4',
  shop: 'b', camera: ' ', mute: 'm', debug: 'f', settings: 'Escape', restart: 'Enter'
});

const PREFS_KEY = 'riftlane.prefs.v1';

export function createStrings(data, locale) {
  const table = data.strings.locales;
  const fallback = data.strings.fallback_locale;
  let loc = locale && table[locale] ? locale : fallback;
  const missing = new Set();
  return {
    get locale() { return loc; },
    setLocale(next) { if (table[next]) loc = next; },
    available() { return Object.keys(table); },
    t(key, vars) {
      let str = table[loc]?.[key] ?? table[fallback]?.[key];
      if (str === undefined) {
        if (!missing.has(key)) { missing.add(key); console.warn(`[i18n] missing string key: ${key}`); }
        return key;
      }
      if (vars) for (const k in vars) str = str.replaceAll(`{${k}}`, String(vars[k]));
      return str;
    },
    missingKeys() { return [...missing]; }
  };
}

export function loadPrefs() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function savePrefs(prefs) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    return true;
  } catch { return false; }
}

export function createUiState(data, opts = {}) {
  const prefs = opts.prefs ?? loadPrefs() ?? {};
  const strings = createStrings(data, prefs.locale || opts.locale || 'zh_cn');
  const ui = {
    strings,
    t: (k, v) => strings.t(k, v),
    playerTeam: opts.playerTeam || 'radiant',
    scale: prefs.scale ?? 1.0,
    colorblind: prefs.colorblind ?? false,
    muted: prefs.muted ?? false,
    showRanges: prefs.showRanges ?? false,
    locale: strings.locale,
    debug: false,
    shopOpen: false,
    settingsOpen: false,
    rebinding: null,
    keybinds: { ...DEFAULT_KEYBINDS, ...(prefs.keybinds || {}) },
    feed: [],
    camera: { x: 0, y: 0, zoom: data.map.camera.zoom_default, targetZoom: data.map.camera.zoom_default },
    fps: 60, lastRenderMs: 0, lastTickMs: 0, aiDebug: null,
    cursor: { x: 0, y: 0, sx: 0, sy: 0 },
    attackMoveArmed: false,
    edgePan: { left: false, right: false, up: false, down: false },
    keysDown: new Set()
  };

  ui.keyLabel = action => {
    const k = ui.keybinds[action];
    if (!k) return '';
    if (k === 'Mouse1') return 'LMB';
    if (k === 'Mouse2') return 'RMB';
    if (k === ' ') return 'Space';
    return k.length === 1 ? k.toUpperCase() : k;
  };

  ui.setPref = (key, value) => {
    ui[key] = value;
    savePrefs({
      scale: ui.scale, colorblind: ui.colorblind, muted: ui.muted,
      showRanges: ui.showRanges, locale: ui.locale, keybinds: ui.keybinds
    });
  };

  ui.pushFeed = (text, color = null) => {
    ui.feed.unshift({ text, color, life: 5.0, maxLife: 5.0 });
    if (ui.feed.length > 6) ui.feed.length = 6;
  };

  ui.update = dt => {
    for (let i = ui.feed.length - 1; i >= 0; i--) {
      ui.feed[i].life -= dt;
      if (ui.feed[i].life <= 0) ui.feed.splice(i, 1);
    }
  };

  /** 把动作名反查为按键（重映射后 HUD 显示当前键位）。 */
  ui.keyFor = action => ui.keybinds[action];
  ui.bindKey = (action, key) => {
    // 一个键不允许绑到两个动作：先解除冲突
    for (const a in ui.keybinds) if (ui.keybinds[a] === key && a !== action) ui.keybinds[a] = '';
    ui.keybinds[action] = key;
    ui.setPref('keybinds', ui.keybinds);
  };
  return ui;
}
