/**
 * src/render/canvas2d.js — 绘制指令的 Canvas2D 后端。
 *
 * 渲染层与模拟层的边界：模拟 → buildDrawList() → 绘制指令数组 → 后端。
 * 后端可替换（浏览器 Canvas2D / tools 里的纯 JS PNG 光栅器），
 * 这就是 tools/render_evidence.mjs 能在无头环境产出与浏览器一致画面的原因，
 * 也是 story-007 "必须真的看一眼并留存截图" 的实现方式。
 */
const NUM_KEYS = ['x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2', 'r', 'a0', 'a1', 'size', 'lineWidth', 'width'];

/** 指令里的数值必须有限；非有限时真实浏览器会静默丢弃绘制（整层消失且无任何报错），这里显式跳过并计数。 */
function finiteOp(d) {
  for (let i = 0; i < NUM_KEYS.length; i++) {
    const v = d[NUM_KEYS[i]];
    if (v !== undefined && !Number.isFinite(v)) return false;
  }
  if (d.points) for (let i = 0; i < d.points.length; i++) if (!Number.isFinite(d.points[i])) return false;
  return true;
}

export let badOpCount = 0;

export function renderDrawList(ctx, list, view) {
  ctx.save();
  ctx.clearRect(0, 0, view.w, view.h);
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (!finiteOp(d)) { badOpCount++; continue; }
    ctx.globalAlpha = d.alpha ?? 1;
    switch (d.op) {
      case 'rect': {
        if (d.fill) { ctx.fillStyle = d.color; ctx.fillRect(d.x, d.y, d.w, d.h); }
        if (d.stroke) { ctx.strokeStyle = d.stroke; ctx.lineWidth = d.lineWidth ?? 1; ctx.strokeRect(d.x, d.y, d.w, d.h); }
        break;
      }
      case 'rrect': {
        roundRect(ctx, d.x, d.y, d.w, d.h, d.r ?? 6);
        if (d.fill) { ctx.fillStyle = d.color; ctx.fill(); }
        if (d.stroke) { ctx.strokeStyle = d.stroke; ctx.lineWidth = d.lineWidth ?? 1; ctx.stroke(); }
        break;
      }
      case 'circle': {
        ctx.beginPath();
        ctx.arc(d.x, d.y, Math.max(0.1, d.r), 0, Math.PI * 2);
        if (d.glow) { ctx.shadowColor = d.color; ctx.shadowBlur = d.glow; }
        if (d.fill !== false) { ctx.fillStyle = d.color; ctx.fill(); }
        ctx.shadowBlur = 0;
        if (d.stroke) { ctx.strokeStyle = d.stroke; ctx.lineWidth = d.lineWidth ?? 2; ctx.stroke(); }
        break;
      }
      case 'ring': {
        ctx.beginPath();
        ctx.arc(d.x, d.y, Math.max(0.1, d.r), d.a0 ?? 0, d.a1 ?? Math.PI * 2);
        ctx.strokeStyle = d.color; ctx.lineWidth = d.width ?? 2;
        if (d.dash) ctx.setLineDash(d.dash);
        ctx.stroke();
        ctx.setLineDash([]);
        break;
      }
      case 'poly': {
        ctx.beginPath();
        const p = d.points;
        ctx.moveTo(p[0], p[1]);
        for (let k = 2; k < p.length; k += 2) ctx.lineTo(p[k], p[k + 1]);
        if (d.close !== false) ctx.closePath();
        if (d.fill !== false) { ctx.fillStyle = d.color; ctx.fill(); }
        if (d.stroke) { ctx.strokeStyle = d.stroke; ctx.lineWidth = d.lineWidth ?? 2; ctx.stroke(); }
        break;
      }
      case 'line': {
        ctx.beginPath(); ctx.moveTo(d.x1, d.y1); ctx.lineTo(d.x2, d.y2);
        ctx.strokeStyle = d.color; ctx.lineWidth = d.width ?? 1;
        if (d.dash) ctx.setLineDash(d.dash);
        ctx.stroke(); ctx.setLineDash([]);
        break;
      }
      case 'text': {
        ctx.font = `${d.bold ? 700 : 400} ${d.size}px ${d.font ?? 'ui-monospace, "SF Mono", Menlo, Consolas, "Noto Sans SC", sans-serif'}`;
        ctx.fillStyle = d.color;
        ctx.textAlign = d.align ?? 'left';
        ctx.textBaseline = d.baseline ?? 'alphabetic';
        if (d.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 4; }
        ctx.fillText(d.text, d.x, d.y);
        ctx.shadowBlur = 0;
        break;
      }
      case 'gradientRect': {
        const g = ctx.createLinearGradient(d.x, d.y, d.x + d.w, d.y + d.h);
        g.addColorStop(0, d.from); g.addColorStop(1, d.to);
        ctx.fillStyle = g; ctx.fillRect(d.x, d.y, d.w, d.h);
        break;
      }
      default: break;
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 测量文本宽度（HUD 布局需要）。后端相关，故由后端提供。 */
export function makeMeasurer(ctx) {
  const cache = new Map();
  return (text, size, bold) => {
    const key = `${bold ? 7 : 4}|${size}|${text}`;
    let w = cache.get(key);
    if (w === undefined) {
      ctx.font = `${bold ? 700 : 400} ${size}px ui-monospace, "SF Mono", Menlo, Consolas, "Noto Sans SC", sans-serif`;
      w = ctx.measureText(text).width;
      if (cache.size > 4000) cache.clear();
      cache.set(key, w);
    }
    return w;
  };
}
