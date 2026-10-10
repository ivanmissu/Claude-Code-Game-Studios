# Engine Reference: Web (Canvas 2D + ES Modules)

Pinned by `/setup-engine` equivalent on 2026-10-10 for **Riftlane**.
This file is the source for the `Risk:` field in every story — a level named
here is a real rating; anything absent is `NOT ASSESSED`, which `/dev-story`
treats as HIGH.

## Pinned versions

| Component | Version | Notes |
|---|---|---|
| Language | JavaScript ES2022 | ES Modules only, no build step, no transpiler |
| Runtime (dev/test) | Node.js 22.22.3 | `node --test` for logic/integration tests |
| Browser target | Chrome/Edge/Firefox/Safari, baseline 2023 | Canvas 2D, `requestAnimationFrame`, WebAudio |
| Renderer | Canvas 2D (`CanvasRenderingContext2D`) | no WebGL, no third-party engine |
| Package manager | none at runtime | npm only if a dev tool is added later |

## Risk ratings by API area

| Area | Risk | Why |
|---|---|---|
| Canvas 2D draw calls, transforms, gradients | LOW | stable since ~2015, uniform across browsers |
| `requestAnimationFrame` timing / dt | LOW | stable; must clamp dt after tab-switch |
| Pointer + keyboard input, `pointerlock` | LOW | stable; pointerlock unused |
| Deterministic fixed-step simulation | LOW | own code, no platform API |
| WebAudio (`AudioContext`, oscillators) | MEDIUM | requires a user gesture to start; autoplay policy differs per browser |
| `devicePixelRatio` scaling / HiDPI | MEDIUM | fractional ratios blur canvas if the backing store is not scaled |
| OffscreenCanvas / workers | HIGH | not used — deliberately avoided for compatibility |
| Gamepad API | NOT ASSESSED | out of scope (`platform.gamepad_support: None`) |

## Deprecated / avoided APIs

- `document.write`, `innerHTML` for HUD updates every frame (layout thrash) — HUD is canvas-drawn or DOM-updated at ≤10 Hz.
- Vendor-prefixed canvas contexts (`webkitGetContext`) — unnecessary on the pinned targets.
- `Math.random()` inside the simulation — see `src/core/rng.js`; a seeded RNG is mandatory for deterministic tests and replays.

## Engine notes that shape the architecture

1. **No scene tree, no node system.** Unlike Godot, nothing owns a transform for free; the simulation holds plain entities and the renderer reads them. This is what makes headless evidence rendering possible.
2. **The browser is both the runtime and the display.** The same simulation module runs under Node for tests (`tools/smoke.mjs`, `tests/`), so gameplay code must not import DOM globals — enforced by `src/gameplay/**` having zero DOM references (also the path rule: gameplay must not reference UI).
3. **Fixed timestep, variable render.** Simulation ticks at 60 Hz with `dt = 1/60` and accumulates real frame time; rendering interpolates. Tab-switch produces one huge `dt` — clamped to 0.25 s.
