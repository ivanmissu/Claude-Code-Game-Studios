# Story 004: 敌方英雄 AI

Epic: riftlane-mvp
Status: Ready
Layer: Core
Type: Logic
Manifest Version: N/A (minimal — no control manifest)
Engine: Web — Canvas 2D / ES2022
Risk: LOW (VERSION.md → "Deterministic fixed-step simulation") · AI 区域参数按 `ai-code.md` 规则全部数据驱动

## Context

- Brief MVP feature 4 — `design/game-brief.md` → "敌方英雄 AI"
- ADR Governing Implementation: N/A (minimal — no ADRs)
- 这是让切片"可对战"的故事：在此之前玩家只是在打木桩与兵线。

## Acceptance Criteria

- [ ] AI 与玩家共用**同一套输入接口**（AI 产出 `input_state`，不直接改实体状态）——保证公平性与可测试性
- [ ] 对线行为：走到合适距离补最后一刀（预判小兵剩余血量与自身弹道时间）
- [ ] 消耗行为：玩家进入技能射程且 AI 法力/冷却允许时释放技能；技能命中率高于随机基线（测试断言）
- [ ] 撤退行为：自身血量低于 `retreat_hp_pct` 或玩家压塔时向己方塔/水晶方向后撤，脱离战斗后回血回蓝
- [ ] 压塔行为：己方兵线在敌方塔下且自身血量健康时攻击塔
- [ ] 回防行为：己方塔被攻击时优先回防
- [ ] 死亡复活后重新上线，走回兵线位置
- [ ] AI 决策可调试：`debug_ai` 输出当前状态机状态与理由（`ai-code.md` 要求可调试性）
- [ ] AI 有性能预算：单个 AI 每 tick 决策耗时上限被断言（`ai-code.md` 要求性能预算）
- [ ] 完整一局中 AI 会补刀、会击杀或被击杀、会推进——`smoke.mjs` 统计 AI 补刀数 > 0 且游戏能结束

## Implementation Notes

- 分层：状态机在 `src/ai/hero_ai.mjs`，参数在 `assets/data/ai.json`（阈值、权重、反应延迟）
- 加**反应延迟与失误率**（数据驱动）：AI 不得有超人的零延迟完美反应，否则不可玩；这也是"可调试性"的一部分
- 与玩家同用 `input_state`，因此 AI 也能被无头脚本替换成回放输入

## Out of Scope

- 多个 AI 队友/敌人（1v1 之外）、AI 打野策略、AI 出装决策（AI 使用固定的数据驱动出装路线，不做动态评估）
- 难度选择菜单（数据文件里保留 `difficulty` 预设，UI 暴露在 story-007 之后再说）

## Test Evidence

- Logic → `tests/unit/test_hero_ai.mjs`：状态机每个转移条件、撤退阈值、反应延迟
- Integration → `tests/integration/test_ai_vs_ai.mjs`：两个 AI 互打一整局，断言有胜负、双方补刀数 > 0、无 NaN、无死锁
- Visual/Feel → 无（AI 行为在 story-007 的画面证据中可见）

## Dependencies

story-001、story-002、story-003
