# Story 003: 防御塔、水晶与胜负判定

Epic: riftlane-mvp
Status: Ready
Layer: Core
Type: Logic
Manifest Version: N/A (minimal — no control manifest)
Engine: Web — Canvas 2D / ES2022
Risk: LOW (VERSION.md → "Deterministic fixed-step simulation")

## Context

- Brief MVP feature 3 — `design/game-brief.md` → "防御塔、水晶与胜负"
- ADR Governing Implementation: N/A (minimal — no ADRs)
- 本故事兑现 brief 的 *Player goal & fail state*：摧毁敌方水晶获胜，己方水晶被摧毁失败，一局 6–12 分钟自然分胜负、无死锁。

## Acceptance Criteria

- [ ] 每方 2 座防御塔 + 1 座水晶，位置与属性来自 `assets/data/map.json` / `towers.json`
- [ ] **塔顺序解锁**：外侧塔未摧毁前，内侧塔与水晶处于无敌状态（受到伤害为 0 并有"无敌"反馈标记）
- [ ] 塔目标优先级：正在攻击友方英雄的敌方英雄 > 范围内敌方小兵（最近优先）> 范围内敌方英雄；塔锁定目标后在 `retarget_interval_sec` 内不换目标，除非当前目标死亡或离开范围
- [ ] 塔对英雄造成真实伤害递增（连续命中同一英雄时伤害按数据递增），使越塔有代价
- [ ] 水晶被摧毁 → `game_over` 事件带 `winner` 与结算统计（时长、击杀、金钱、补刀、塔）
- [ ] 游戏结束后模拟停止接受输入、不再推进实体（可重开）
- [ ] `tools/smoke.mjs` 能以固定种子无人值守跑完整局并分出胜负，**不超时死锁**
- [ ] 无 NaN：任何伤害/位置计算不得产生 NaN 或 Infinity（测试断言全实体状态有限）

## Implementation Notes

- 新增 `tower` / `nexus` 静态实体类型与 `objective_rules` 系统（无敌解锁、胜利判定）
- 塔的"递增真实伤害"是防越塔刷杀的关键，数值进 `assets/data/towers.json`
- 胜负判定必须只依赖模拟状态（不得依赖渲染或 DOM），以便无头验证

## Out of Scope

- 基地内的防御建筑（兵营/水晶塔）、超级兵
- 投降、重开、暂停菜单（story-007 只做结算面板与重开按钮的最小实现）
- 高地/野区入口的地形阻挡

## Test Evidence

- Logic → `tests/unit/test_towers.mjs`：无敌解锁顺序、目标优先级各分支、递增伤害
- Integration → `tests/integration/test_full_game.mjs`：脚本化输入推掉两座塔与水晶，断言 `winner === 'radiant'|'dire'` 且统计完整
- Smoke → `node tools/smoke.mjs` 退出码 0，输出胜负与用时

## Dependencies

story-001、story-002（塔需要小兵作为目标来源）
