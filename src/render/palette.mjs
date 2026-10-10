/**
 * src/render/palette.js — 配色与形状编码。
 *
 * 无障碍（story-007 / accessibility.target: standard）：阵营信息**同时**用颜色与形状
 * 传递，颜色对 deuteranopia（红绿色盲）安全 —— 青 (#37d6e8) 与品红 (#ff5ec8)
 * 在红绿色盲模拟下亮度与色相都可区分。色盲友好开关会进一步拉开亮度差。
 */
export const PALETTE = {
  bg: '#0a0c12',
  bgDeep: '#070910',
  terrain: '#111726',
  terrainEdge: '#1d2740',
  lane: '#1b2438',
  laneEdge: '#2b3a5c',
  river: '#132a3a',
  grid: '#141b2b',

  teamRadiant: '#37d6e8',
  teamRadiantDark: '#1b6d78',
  teamDire: '#ff5ec8',
  teamDireDark: '#8a2f6c',
  neutral: '#f0a63c',
  neutralDark: '#7d5418',

  health: '#54d97a',
  healthEnemy: '#ff5e6c',
  mana: '#4f9dff',
  xp: '#f5c542',
  shield: '#c9d6ff',

  damagePhysical: '#ffd479',
  damageMagic: '#9fb6ff',
  damageTrue: '#ffffff',

  spell: '#a684ff',
  cast: '#c9b6ff',
  dash: '#7ef0d8',
  buff: '#ffd479',
  hit: '#ffffff',
  spark: '#ffd479',
  telegraph: '#ff5e6c',
  telegraphAlly: '#37d6e8',

  panel: '#121826',
  panelEdge: '#26314a',
  panelHi: '#1b2437',
  text: '#e8ecf6',
  textDim: '#98a2b8',
  textFaint: '#5f6a80',
  gold: '#f5c542',
  danger: '#ff5e6c',
  ok: '#54d97a',
  cooldown: 'rgba(6,8,14,0.72)'
};

/** 色盲友好模式：拉开明度差 + 提高描边对比。 */
export const PALETTE_CB = {
  ...PALETTE,
  teamRadiant: '#4fe3ff',
  teamRadiantDark: '#1d7f92',
  teamDire: '#ffb03a',
  teamDireDark: '#8a5a12',
  neutral: '#e8e8e8',
  health: '#7dffa8',
  healthEnemy: '#ff8a3d'
};

export function paletteFor(ui) { return ui?.colorblind ? PALETTE_CB : PALETTE; }

/**
 * 形状编码：即使完全看不到颜色也能区分单位类型。
 * triangle = 玩家英雄, diamond = 敌方英雄, square = 近战兵,
 * circle_small = 远程兵, hexagon = 攻城兵/野怪, tower/nexus = 建筑。
 */
export function shapeOf(e) {
  if (e.shape) return e.shape;
  if (e.kind === 'hero') return e.team === 'radiant' ? 'triangle' : 'diamond';
  if (e.kind === 'structure') return e.structureKind === 'nexus' ? 'nexus' : 'tower';
  return 'circle_small';
}

export function teamColor(P, team) {
  if (team === 'radiant') return P.teamRadiant;
  if (team === 'dire') return P.teamDire;
  return P.neutral;
}
