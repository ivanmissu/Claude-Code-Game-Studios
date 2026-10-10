# Story 001: 英雄操作与镜头

Epic: riftlane-mvp
Status: Ready
Layer: Core
Type: Logic
Manifest Version: N/A (minimal — no control manifest)
Engine: Web — Canvas 2D / ES2022
Risk: LOW (VERSION.md → "Deterministic fixed-step simulation", "Canvas 2D draw calls", "requestAnimationFrame timing")

## Context

- Brief MVP feature 1 — `design/game-brief.md` → "可操作的英雄与镜头"
- ADR Governing Implementation: N/A (minimal — no ADRs)
- No GDD/TR at this tier: acceptance criteria derive from the brief's *Player goal & fail state* and MVP feature 1.

## Acceptance Criteria

- [ ] 右键点击地面：英雄沿路径移动到该点，到达后停下（无抖动、无过冲）
- [ ] `A` + 左键（攻击移动）：移动到目标点，途中若进入攻击范围则停下攻击最近合法目标
- [ ] QWER 四技能可释放：各自有施法形式（指向性直线 / 目标点范围 / 自身位移 / 自身增益）、法力消耗、冷却时间、射程；法力不足或在冷却中时释放失败并有反馈
- [ ] 被动技能生效且不需要按键
- [ ] 英雄死亡后进入复活倒计时，倒计时结束在水晶处复活并恢复满血满蓝
- [ ] 镜头跟随英雄，可用鼠标边缘/方向键平移、滚轮缩放，缩放宽严有上下限
- [ ] 模拟为固定步长 60 Hz 且**确定性**：同一种子同一输入序列跑两次，第 N tick 的全部实体状态逐位相同
- [ ] 关卡数据（英雄属性、技能数值、地图路径）**全部来自 `assets/data/*.json`**，`src/gameplay/**` 内无硬编码数值

## Implementation Notes

- 代码根：`src/`（Web 无引擎约束，沿用模板的 Godot 行；见 `.claude/docs/directory-structure.md`）
- 分层，遵守路径规则：
  - `src/core/` 零分配热路径（实体池、无 GC 压力的向量运算）、稳定 API、线程无关（单线程但不得依赖全局可变状态）
  - `src/gameplay/` 数据驱动、必须使用 dt、**禁止引用 UI/DOM**
  - `src/render/` 只做"绘制指令 → 后端"，两个后端：`canvas2d` 与 `png`（供无头证据渲染）
- 输入抽象为 `input_state`（每 tick 一份可序列化的快照），使模拟可在 Node 中被脚本驱动 → 这是 smoke 测试与证据渲染的前提
- 确定性 RNG（`src/core/rng.js`）：模拟内**禁用 `Math.random()`**

## Out of Scope

- 小兵、塔、野怪、装备、AI（后续故事）
- 视野/战争迷雾、多人联网、英雄池与选人界面
- HUD（story-007），本故事只在控制台/调试层输出状态

## Test Evidence

- Logic → `tests/unit/` + `tests/integration/`，`node --test tests/` 全绿（`testing.strict.logic: true`，失败**阻断**关闭）
- 确定性专项：`tests/unit/test_determinism.mjs` 断言两次运行状态哈希相同
- Visual/Feel → 无（本故事不交付玩家可见画面，画面证据在 story-007）

## Dependencies

None — 这是第一个故事。
