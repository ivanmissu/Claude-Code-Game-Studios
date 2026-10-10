# Story 006: 野区与增益

Epic: riftlane-mvp
Status: Ready
Layer: Core
Type: Logic
Manifest Version: N/A (minimal — no control manifest)
Engine: Web — Canvas 2D / ES2022
Risk: LOW (VERSION.md → "Deterministic fixed-step simulation")

## Context

- Brief MVP feature 6 — `design/game-brief.md` → "野区与增益"
- ADR Governing Implementation: N/A (minimal — no ADRs)

## Acceptance Criteria

- [ ] 路旁 3 组中立野怪营地（红 buff / 蓝 buff / 大龙位），位置与构成来自 `assets/data/jungle.json`
- [ ] 中立野怪有**牵引范围**：被攻击后追击，超出牵引范围或目标离开后返回营地并回复满血（防风筝到基地）
- [ ] 中立野怪不主动攻击路过单位，除非被攻击（区别于小兵）
- [ ] 击杀营地给击杀者阵营增益：红=攻击附带持续真实伤害，蓝=法力回复与冷却缩减，大龙=全队强化 + 金钱奖励
- [ ] 增益有持续时间，到期自动移除；死亡时按数据决定是否丢失
- [ ] 营地按 `respawn_sec` 刷新，刷新时间在 HUD 可见（story-007）
- [ ] 大龙在 `spawn_after_sec` 之前不存在（前期不可争夺，制造节奏点）

## Implementation Notes

- 复用 minion 的实体与战斗管线，新增 `neutral` 阵营（既非 radiant 也非 dire）
- buff 系统必须是通用容器（`src/gameplay/buffs.mjs`），story-005 的物品与技能增益也走同一条路径，避免三套加成逻辑
- 牵引/返回逻辑放在 `src/ai/`，参数数据驱动

## Out of Scope

- 完整野区地图、多组小野、河道蟹、视野控制
- 大龙的"击杀后召唤超级兵"效果（记为 backlog）
- 打野专属路线 AI（AI 只在数据允许时顺便打红/蓝，不做大龙争夺决策）

## Test Evidence

- Logic → `tests/unit/test_jungle.mjs`：牵引与返回、中立不主动攻击、增益时长与到期、刷新计时、大龙生成时间门槛
- Integration → `tests/integration/test_buff_combat.mjs`：带红 buff 的普攻确实附带真实伤害（对比无 buff 的总伤害）
- Visual/Feel → 无（营地与增益图标的画面证据在 story-007）

## Dependencies

story-002（实体与战斗管线）、story-003（阵营与胜负不受中立单位影响）、story-005（buff 容器与属性叠加）
