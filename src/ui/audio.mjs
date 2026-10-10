/**
 * src/ui/audio.js — WebAudio 合成音效（零音频素材）。
 *
 * VERSION.md 标注为 MEDIUM 风险：AudioContext 必须由用户手势创建/恢复，
 * 且各浏览器自动播放策略不同 —— 所以 unlock() 挂在第一次 pointerdown/keydown 上，
 * 在解锁前所有音效都是安全的空操作。静音开关走 ui.muted（持久化偏好）。
 *
 * 本模块属于 ui 层：模拟不 import 它，Node 端无 AudioContext 也不会崩。
 */
export function createAudio(ui) {
  let ctx = null;
  let master = null;
  let unlocked = false;

  function ensure() {
    if (ctx || typeof AudioContext === 'undefined') return ctx;
    try {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.32;
      master.connect(ctx.destination);
    } catch (e) {
      console.warn('[audio] AudioContext unavailable:', e.message);
      ctx = null;
    }
    return ctx;
  }

  function ok() {
    if (ui.muted || !ctx || ctx.state === 'closed') return false;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return true;
  }

  function tone(freq, dur, type = 'sine', gain = 0.5, slideTo = null, delay = 0) {
    if (!ok()) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), t0 + Math.min(0.02, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(master);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }

  function noise(dur, gain = 0.35, filterFreq = 1400) {
    if (!ok()) return;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = filterFreq;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(f); f.connect(g); g.connect(master);
    src.start();
  }

  return {
    unlock() {
      if (unlocked) return;
      unlocked = true;
      ensure();
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    },
    cast(slot) {
      const base = { q: 520, w: 380, e: 300, r: 220 }[slot] ?? 440;
      tone(base, 0.16, slot === 'r' ? 'sawtooth' : 'triangle', 0.34, base * 1.9);
      if (slot === 'r') tone(base * 2, 0.34, 'sine', 0.2, base * 3, 0.02);
    },
    hit() { noise(0.06, 0.2, 2200); },
    lastHit() { tone(880, 0.07, 'square', 0.18, 1320); },
    move() { tone(300, 0.045, 'sine', 0.1); },
    attackMove() { tone(420, 0.06, 'triangle', 0.14, 620); },
    select() { tone(660, 0.05, 'sine', 0.12); },
    click() { tone(1200, 0.03, 'square', 0.07); },
    deny() { tone(180, 0.09, 'square', 0.1, 140); },
    buy() { tone(720, 0.08, 'triangle', 0.2); tone(1080, 0.1, 'triangle', 0.16, null, 0.06); },
    levelUp() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.16, 'triangle', 0.2, null, i * 0.06)); },
    structure() { noise(0.42, 0.42, 700); tone(120, 0.4, 'sawtooth', 0.24, 60); },
    camp() { tone(300, 0.12, 'triangle', 0.16, 420); },
    buff() { [392, 523, 659].forEach((f, i) => tone(f, 0.22, 'sine', 0.18, null, i * 0.07)); },
    death(mineIsVictim) {
      if (mineIsVictim) { tone(220, 0.5, 'sawtooth', 0.26, 70); noise(0.3, 0.24, 500); }
      else { tone(330, 0.3, 'triangle', 0.2, 160); }
    },
    gameOver(win) {
      const seq = win ? [523, 659, 784, 1046, 1318] : [392, 349, 294, 220];
      seq.forEach((f, i) => tone(f, win ? 0.4 : 0.5, win ? 'triangle' : 'sawtooth', 0.22, null, i * 0.14));
    },
    get ready() { return !!ctx && ctx.state === 'running'; }
  };
}
