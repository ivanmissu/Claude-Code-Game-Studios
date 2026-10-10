# Story 002: 兵线波次与补刀

Epic: riftlane-mvp
Status: Ready
Layer: Core
Type: Logic
Manifest Version: N/A (minimal — no control manifest)
Engine: Web — Canvas 2D / ES2022
Risk: LOW (VERSION.md → "Deterministic fixed-step simulation")

## Context

- Brief MVP feature 2 — `design/game-brief.md` → "兵线与补刀"
- ADR Governing Implementation: N/A (minimal — no ADRs)

## Acceptance Criteria

- [ ] 双方水晶按 `wave_interval_sec` 定期出兵，每波构成来自数据文件（近战 ×N、远程 ×N、每 K 波附加攻城 ×1）
- [ ] 小兵沿车道路径点向敌方基地方向推进，路径来自 `assets/data/map.json`
- [ ] 仇恨优先级正确：正在攻击我方的敌人 > 附近的敌方小兵 > 附近的敌方英雄 > 继续推进；目标丢失后回到推进状态
- [ ] 小兵有攻击范围、攻击间隔、护甲与伤害类型（物理/魔法/真实），伤害结算走统一函数
- [ ] **末刀（last hit）**：只有造成致命一击的单位所属阵营获得金钱奖励；经验按范围内友方英雄分摊
- [ ] 小兵死亡后从模拟中移除并归还实体池（长时间运行实体数不单调增长）
- [ ] 兵线在无人干预时自然在地图中部相遇并对推（`smoke.mjs` 断言）

## Implementation Notes

- 复用 story-001 的伤害/死亡/掉落路径，新增 `minion` 实体类型与 `wave_spawner` 系统
- 小兵 AI 放在 `src/ai/`（遵守 ai-code 规则：参数全部数据驱动、可调试输出、有性能预算——每 tick 目标搜索不得做全量 O(n²) 配对，用空间网格）
- 金钱/经验数值全部进 `assets/data/minions.json` 与 `heroes.json`

## Out of Scope

- 防御塔与水晶的伤害/胜负（story-003）
- 超级兵/兵线强化随时间升级（记为 backlog，不在 MVP）
- 反补（deny）机制——MOBA 传统但不属于本切片的 MVP

## Test Evidence

- Logic → `tests/unit/test_minions.mjs`：波次构成、仇恨优先级各分支、末刀归属
- Integration → `tests/integration/test_lane_push.mjs`：无输入跑 240 tick×N，断言兵线相遇点与实体池无泄漏
- Visual/Feel → 无（画面证据在 story-007）

## Dependencies

story-001（英雄、伤害管线、固定步长模拟）
