# Story 005: 等级成长与装备商店

Epic: riftlane-mvp
Status: Ready
Layer: Core
Type: Logic
Manifest Version: N/A (minimal — no control manifest)
Engine: Web — Canvas 2D / ES2022
Risk: LOW (VERSION.md → "Deterministic fixed-step simulation")

## Context

- Brief MVP feature 5 — `design/game-brief.md` → "等级成长与装备商店"
- ADR Governing Implementation: N/A (minimal — no ADRs)

## Acceptance Criteria

- [ ] 经验曲线 1–18 级来自数据文件；升级时属性按每级成长值重算（攻击力、法强、护甲、魔抗、生命、法力、生命回复、法力回复、攻速、移速）
- [ ] 升级给 1 点技能点，可用于提升 QWER 任一技能等级；技能等级改变其数值（伤害/冷却/消耗），每技能有等级上限且受英雄等级限制
- [ ] 金钱来源：被动收入（每秒/每波）、小兵末刀、击杀英雄、野怪（story-006）
- [ ] 商店：物品数据来自 `assets/data/items.json`，含价格、属性、合成关系（MVP 只做单层：基础件 → 成品件，不做多级合成树）
- [ ] 购买扣钱并占用 6 格之一；栏位满或金钱不足时购买失败并有反馈；出售返还 `sell_ratio`
- [ ] 物品属性正确叠加进面板并影响实际战斗数值（伤害、冷却缩减、生命偷取等）
- [ ] AI 按数据驱动的固定出装路线购买（story-004 的 AI 复用同一套购买接口）
- [ ] 属性计算无浮点漂移导致的错误：同一状态重算两次结果相同（`stats` 为纯函数）

## Implementation Notes

- `src/gameplay/stats.mjs` 必须是**纯函数**：`computeStats(hero, level, skillLevels, items, buffs) -> stats`，不缓存可变全局，便于测试与确定性
- 冷却缩减、生命偷取等派生属性有上下限（数据驱动 clamp），避免出现 100% CDR 或负数攻速
- 商店 UI 归 story-007；本故事只交付购买/出售的**模拟接口**与数据

## Out of Scope

- 多级合成树、主动物品（如闪现/护盾道具）、消耗品与眼位
- 符文/天赋页、皮肤加成
- 动态出装推荐算法

## Test Evidence

- Logic → `tests/unit/test_stats.mjs`：等级成长、技能等级数值、物品叠加、clamp 边界、纯函数重算一致性
- Config/Data → `tests/unit/test_data_integrity.mjs`：`items.json` / `heroes.json` 的 schema 与引用完整性（`testing.strict.config: false`，仅建议性）
- Visual/Feel → 无（商店画面证据在 story-007）

## Dependencies

story-001（英雄属性）、story-002（金钱/经验来源）
