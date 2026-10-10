# Epic: riftlane-mvp

Layer: Core
Brief: design/game-brief.md
Architecture Module: N/A (minimal — no /create-architecture at this tier)
Status: Ready
Created: 2026-10-10

## Governing ADRs

| ADR | Status | Applies to |
|---|---|---|
| N/A (minimal — no ADRs) | — | all stories |

At `workflow: minimal` this EPIC.md was written by `/create-stories` from the
one-page brief. No GDD, ADR, control manifest or TR registry is read; stories
trace to `Brief MVP feature N`.

## Brief MVP features

| # | MVP feature | Story |
|---|---|---|
| 1 | 可操作的英雄与镜头 | story-001 |
| 2 | 兵线与补刀 | story-002 |
| 3 | 防御塔、水晶与胜负 | story-003 |
| 4 | 敌方英雄 AI | story-004 |
| 5 | 等级成长与装备商店 | story-005 |
| 6 | 野区与增益 | story-006 |
| 7 | HUD、反馈与无障碍 | story-007 |

> Story numbers follow the brief's **build order** 1:1, so `story-NNN` traces to
> `Brief MVP feature N`. The order deliberately puts the enemy AI (feature 4)
> ahead of progression and jungle: the slice is not playable *against anything*
> until an opponent exists, and CCGS says build the risky, core-fun thing first.

## Stories

| # | Story | Type | Status | ADR |
|---|---|---|---|---|
| 001 | 英雄操作与镜头 | Logic | Ready | N/A (minimal) |
| 002 | 兵线波次与补刀 | Logic | Ready | N/A (minimal) |
| 003 | 防御塔、水晶与胜负判定 | Logic | Ready | N/A (minimal) |
| 004 | 敌方英雄 AI | Logic | Ready | N/A (minimal) |
| 005 | 等级成长与装备商店 | Logic | Ready | N/A (minimal) |
| 006 | 野区与增益 | Logic | Ready | N/A (minimal) |
| 007 | HUD、反馈与无障碍 | UI | Ready | N/A (minimal) |

## Dependencies

001 → 002 → 003 → 004 (each needs the previous); 005 and 006 need 002+003;
007 needs all of them (it renders and exposes what exists).
