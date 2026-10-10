/**
 * tools/png_encoder.mjs — 纯 JS 的 PNG 光栅器（无原生依赖、无浏览器）。
 *
 * 存在的理由：CCGS 规定"改动玩家可见内容的故事必须真的跑起来看一眼并留存截图"
 * （README → It runs the game and looks at it；testing.strict.visual = true 时缺图阻断关闭）。
 * 本沙箱没有浏览器，所以证据图由这里把 **真实的绘制指令** 光栅化成 PNG ——
 * 绘制指令来自 src/render/draw.mjs 与 src/render/hud.mjs，也就是浏览器里跑的同一份代码，
 * 因此证据图与玩家看到的画面在几何、配色、布局上一致。
 *
 * 已知限制（写在 story-007 的 Test Evidence 里，不藏着）：
 *   - `text` 指令按字宽渲染成占位块，真实文案与坐标写进同名 .json 边车文件供审计
 *     （纯 JS 光栅器没有 CJK 字形；浏览器端用系统字体正常渲染中文）。
 *   - 不支持渐变以外的混合模式、阴影模糊（glow 以同心圆近似）。
 */
import { deflateSync } from 'node:zlib';

export function createFramebuffer(width, height, bg = [10, 12, 18]) {
  const w = Math.max(1, width | 0), h = Math.max(1, height | 0);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = 255;
  }
  return { w, h, data };
}

function parseColor(c) {
  if (!c) return [255, 255, 255, 1];
  if (Array.isArray(c)) return [c[0], c[1], c[2], c[3] ?? 1];
  if (c.startsWith('rgba(')) {
    const m = c.slice(5, -1).split(',').map(s => parseFloat(s));
    return [m[0], m[1], m[2], m[3]];
  }
  if (c.startsWith('rgb(')) {
    const m = c.slice(4, -1).split(',').map(s => parseFloat(s));
    return [m[0], m[1], m[2], 1];
  }
  if (c.startsWith('#')) {
    let hex = c.slice(1);
    if (hex.length === 3) hex = hex.split('').map(x => x + x).join('');
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 1];
  }
  return [255, 0, 255, 1];
}

function blend(fb, x, y, rgba, alpha) {
  x = x | 0; y = y | 0;
  if (x < 0 || y < 0 || x >= fb.w || y >= fb.h) return;
  const a = rgba[3] * alpha;
  if (a <= 0) return;
  const i = (y * fb.w + x) * 4;
  const inv = 1 - a;
  fb.data[i] = fb.data[i] * inv + rgba[0] * a;
  fb.data[i + 1] = fb.data[i + 1] * inv + rgba[1] * a;
  fb.data[i + 2] = fb.data[i + 2] * inv + rgba[2] * a;
  fb.data[i + 3] = 255;
}

export function fillRect(fb, x, y, w, h, color, alpha = 1) {
  const rgba = parseColor(color);
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(fb.w, Math.ceil(x + w)), y1 = Math.min(fb.h, Math.ceil(y + h));
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) blend(fb, xx, yy, rgba, alpha);
}

export function fillCircle(fb, cx, cy, r, color, alpha = 1) {
  const rgba = parseColor(color);
  const rr = r * r;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(fb.w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(fb.h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= rr) blend(fb, x, y, rgba, alpha);
    }
  }
}

export function strokeCircle(fb, cx, cy, r, width, color, alpha = 1, a0 = 0, a1 = Math.PI * 2, dash = null) {
  const rgba = parseColor(color);
  const steps = Math.max(12, Math.ceil(Math.abs(a1 - a0) * r * 1.2));
  const half = width / 2;
  let on = true, acc = 0;
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (a1 - a0) * (i / steps);
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (dash) {
      acc += (i > 0) ? Math.abs(a1 - a0) * r / steps : 0;
      if (acc > dash[0]) { acc = 0; on = !on; }
      if (!on) continue;
    }
    for (let dy = -half; dy <= half; dy++) for (let dx = -half; dx <= half; dx++) {
      if (dx * dx + dy * dy <= half * half) blend(fb, x + dx, y + dy, rgba, alpha);
    }
  }
}

export function drawLine(fb, x1, y1, x2, y2, width, color, alpha = 1, dash = null) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.max(1, Math.ceil(len));
  let on = true, acc = 0;
  for (let i = 0; i <= steps; i++) {
    if (dash) {
      acc++;
      if (acc > dash[0]) { acc = 0; on = !on; }
      if (!on) continue;
    }
    const t = i / steps;
    fillCircle(fb, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, width / 2, color, alpha);
  }
}

export function fillPoly(fb, points, color, alpha = 1) {
  if (points.length < 6) return;
  const rgba = parseColor(color);
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < points.length; i += 2) { minY = Math.min(minY, points[i]); maxY = Math.max(maxY, points[i]); }
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(fb.h - 1, Math.ceil(maxY));
  const n = points.length / 2;
  const xs = [];
  for (let y = y0; y <= y1; y++) {
    xs.length = 0;
    const yc = y + 0.5;
    for (let i = 0; i < n; i++) {
      const a = [points[i * 2], points[i * 2 + 1]];
      const b = [points[((i + 1) % n) * 2], points[((i + 1) % n) * 2 + 1]];
      if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) {
        xs.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k])), xb = Math.min(fb.w - 1, Math.floor(xs[k + 1]));
      for (let x = xa; x <= xb; x++) blend(fb, x, y, rgba, alpha);
    }
  }
}

export function strokePoly(fb, points, width, color, alpha = 1, close = true) {
  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (!close && j === 0) break;
    drawLine(fb, points[i * 2], points[i * 2 + 1], points[j * 2], points[j * 2 + 1], width, color, alpha);
  }
}

export function roundRect(fb, x, y, w, h, r, fillColor, strokeColor, lineWidth, alpha = 1) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  if (fillColor) {
    fillRect(fb, x + rr, y, w - rr * 2, h, fillColor, alpha);
    fillRect(fb, x, y + rr, w, h - rr * 2, fillColor, alpha);
    fillCircle(fb, x + rr, y + rr, rr, fillColor, alpha);
    fillCircle(fb, x + w - rr, y + rr, rr, fillColor, alpha);
    fillCircle(fb, x + rr, y + h - rr, rr, fillColor, alpha);
    fillCircle(fb, x + w - rr, y + h - rr, rr, fillColor, alpha);
  }
  if (strokeColor) {
    strokeCircle(fb, x + rr, y + rr, rr, lineWidth, strokeColor, alpha, Math.PI, Math.PI * 1.5);
    strokeCircle(fb, x + w - rr, y + rr, rr, lineWidth, strokeColor, alpha, -Math.PI * 0.5, 0);
    strokeCircle(fb, x + w - rr, y + h - rr, rr, lineWidth, strokeColor, alpha, 0, Math.PI * 0.5);
    strokeCircle(fb, x + rr, y + h - rr, rr, lineWidth, strokeColor, alpha, Math.PI * 0.5, Math.PI);
    drawLine(fb, x + rr, y, x + w - rr, y, lineWidth, strokeColor, alpha);
    drawLine(fb, x + rr, y + h, x + w - rr, y + h, lineWidth, strokeColor, alpha);
    drawLine(fb, x, y + rr, x, y + h - rr, lineWidth, strokeColor, alpha);
    drawLine(fb, x + w, y + rr, x + w, y + h - rr, lineWidth, strokeColor, alpha);
  }
}

/* ---------------------------------------------------------------- 指令 → 像素 */
/**
 * 渲染一份绘制指令。返回 {texts, outOfViewport}：
 *   texts — 每条 text 指令的文案与包围盒（写进边车文件，供人工/脚本审计）
 *   outOfViewport — 落在视口外的绘制项（story-007 "HUD 必须在可见范围内" 的自动检查）
 */
export function rasterize(fb, list, opts = {}) {
  const texts = [];
  const outOfViewport = [];
  const charWidth = opts.charWidth ?? 0.62;
  for (const d of list) {
    const alpha = d.alpha ?? 1;
    switch (d.op) {
      case 'rect':
        if (d.fill !== false && d.color !== 'transparent') fillRect(fb, d.x, d.y, d.w, d.h, d.color, alpha);
        if (d.stroke) roundRect(fb, d.x, d.y, d.w, d.h, 0, null, d.stroke, d.lineWidth ?? 1, alpha);
        break;
      case 'rrect':
        roundRect(fb, d.x, d.y, d.w, d.h, d.r ?? 6, d.fill === false || d.color === 'transparent' ? null : d.color, d.stroke, d.lineWidth ?? 1, alpha);
        break;
      case 'circle':
        if (d.glow) fillCircle(fb, d.x, d.y, d.r * 1.5, d.color, alpha * 0.16);
        if (d.fill !== false) fillCircle(fb, d.x, d.y, d.r, d.color, alpha);
        if (d.stroke) strokeCircle(fb, d.x, d.y, d.r, d.lineWidth ?? 2, d.stroke, alpha);
        break;
      case 'ring':
        strokeCircle(fb, d.x, d.y, d.r, d.width ?? 2, d.color, alpha, d.a0 ?? 0, d.a1 ?? Math.PI * 2, d.dash ?? null);
        break;
      case 'poly':
        if (d.fill !== false) fillPoly(fb, d.points, d.color, alpha);
        if (d.stroke) strokePoly(fb, d.points, d.lineWidth ?? 2, d.stroke, alpha, d.close !== false);
        break;
      case 'line':
        drawLine(fb, d.x1, d.y1, d.x2, d.y2, d.width ?? 1, d.color, alpha, d.dash ?? null);
        break;
      case 'gradientRect': {
        const from = parseColor(d.from), to = parseColor(d.to);
        const steps = Math.max(1, Math.ceil(Math.hypot(d.w, d.h)));
        for (let i = 0; i < steps; i++) {
          const t = i / steps;
          const c = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t, 1];
          fillRect(fb, d.x + d.w * t, d.y, Math.max(1, d.w / steps) + 1, d.h, c, alpha);
        }
        break;
      }
      case 'text': {
        const size = d.size ?? 12;
        const w = String(d.text).length * size * charWidth;
        const h = size * 0.92;
        let x = d.x, y = d.y - h;
        if (d.align === 'center') x = d.x - w / 2;
        else if (d.align === 'right') x = d.x - w;
        if (d.baseline === 'middle') y = d.y - h / 2;
        else if (d.baseline === 'top') y = d.y;
        const box = { x: +x.toFixed(1), y: +y.toFixed(1), w: +w.toFixed(1), h: +h.toFixed(1) };
        texts.push({ text: String(d.text), size, align: d.align ?? 'left', color: d.color, alpha, ...box });
        // 占位块：保留真实排版尺寸，使"是否溢出视口/是否互相重叠"可被检查
        fillRect(fb, box.x, box.y + h * 0.18, box.w, h * 0.62, d.color, alpha * 0.85);
        if (box.x < -1 || box.y < -1 || box.x + box.w > fb.w + 1 || box.y + box.h > fb.h + 1) {
          outOfViewport.push({ op: 'text', text: String(d.text), ...box });
        }
        break;
      }
      default: break;
    }
    if (d.op !== 'text') {
      const xs = d.x ?? d.x1 ?? (d.points ? d.points[0] : null);
      const ys = d.y ?? d.y1 ?? (d.points ? d.points[1] : null);
      if (xs !== null && ys !== null && (xs < -400 || ys < -400 || xs > fb.w + 400 || ys > fb.h + 400)) {
        outOfViewport.push({ op: d.op, x: xs, y: ys });
      }
    }
  }
  return { texts, outOfViewport };
}

/* ---------------------------------------------------------------- PNG 编码 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** @returns {Buffer} PNG 文件内容（8-bit RGBA，无隔行） */
export function encodePng(fb) {
  const { w, h, data } = fb;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                       // filter: None
    const row = data.subarray(y * stride, (y + 1) * stride);
    raw.set(row, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
