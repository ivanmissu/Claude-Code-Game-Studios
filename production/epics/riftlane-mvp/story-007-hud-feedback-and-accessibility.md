# Story 007: HUD、反馈与无障碍

Epic: riftlane-mvp
Status: Ready
Layer: Feature
Type: UI
Manifest Version: N/A (minimal — no control manifest)
Engine: Web — Canvas 2D / ES2022
Risk: MEDIUM (VERSION.md → "WebAudio requires a user gesture", "devicePixelRatio scaling / HiDPI")

## Context

- Brief MVP feature 7 — `design/game-brief.md` → "HUD、反馈与无障碍"
- ADR Governing Implementation: N/A (minimal — no ADRs)
- 这是本切片**唯一交付玩家可见画面**的故事，因此 `testing.strict.visual` 与 `testing.strict.ui` 为 true：**没有留存截图，故事不能关闭**（解析检查不等于运行）。

## Acceptance Criteria

- [ ] HUD 显示：英雄生命/法力条、等级与经验条、金钱、QWER 图标 + 冷却遮罩 + 快捷键提示、技能点可用提示、复活倒计时、游戏计时、双方塔/水晶状态、双方 KDA 与补刀数
- [ ] 商店面板：可打开/关闭，显示物品价格与属性，可点击购买/出售，栏位满与金钱不足有明确反馈
- [ ] 世界层反馈：单位血条（阵营色 + 形状区分）、伤害数字、命中粒子、技能拖尾、死亡爆炸、塔无敌标记、野怪营地刷新倒计时、增益图标
- [ ] 击杀提示流（kill feed）与结算面板（胜负、时长、统计、重开按钮）
- [ ] 音效：WebAudio 合成的施法/命中/死亡/购买/胜负音；**首次用户手势后才创建 AudioContext**，且有静音开关（默认开启声音但可关）
- [ ] HiDPI 正确：canvas 后备缓冲按 `devicePixelRatio` 缩放，文字与图形不模糊
- [ ] HUD 必须在可见范围内：所有 HUD 元素位于视口内、不遮挡关键战斗区域（截图证据必须能看出这一点）
- [ ] **无障碍**（`accessibility.target: standard`）：
  - [ ] 色盲安全：阵营用青/品红（deuteranopia 可区分）**并同时**用形状（我方三角、敌方菱形、中立圆）区分——不依赖颜色单独传递信息
  - [ ] 按键可重映射，重映射后持久（localStorage）并在 HUD 显示当前键位
  - [ ] UI 字号缩放（≥1.0 / 1.25 / 1.5），缩放后 HUD 不溢出错位
  - [ ] 所有状态提示同时有文字与颜色两种编码（如"无敌"既有标记也有文字）
- [ ] 帧率达标：`performance.target_framerate: 60`，在 200 实体规模下每帧渲染 < 16.67 ms（`performance.enforce: warn` → 超标打印警告）

## Implementation Notes

- `src/ui/` **不得持有游戏状态**（ui-code 规则）：只读模拟状态并绘制，输入转成 `input_state` 交给模拟；本地化就绪（所有文案走 `assets/data/strings.json`，不硬编码字符串）
- 渲染管线：模拟 → 绘制指令列表 → 后端（`canvas2d` / `png`）。HUD 与世界层都走这条管线，因此 `tools/render_evidence.mjs` 能无头产出**与浏览器一致**的截图
- WebAudio 只在浏览器后端存在；模拟与 Node 端不得引用 `AudioContext`

## Out of Scope

- 设置菜单的完整化（只做键位/字号/音量三项）、教学提示、观战 UI、回放 UI
- 移动端/触屏布局、手柄图标
- 语音、音乐、音频素材文件（仅程序合成音效）

## Test Evidence

- UI → **留存截图** `production/qa/evidence/story-007-*.png`（对局中 HUD、商店面板、结算面板、字号 1.5 缩放、色盲模拟视图各一张），由 `tools/render_evidence.mjs` 无头渲染真实模拟状态产生
- Visual/Feel → 同上，另加命中粒子与技能拖尾的一张
- Logic → `tests/unit/test_ui_state.mjs`：HUD 布局计算在 1280×720 与 1920×1080 下元素均在视口内、字号缩放不溢出
- 人工确认：由用户在 LIVE PREVIEW 中实际游玩并确认手感（协作协议要求用户批准）

## Dependencies

story-001 … story-006（它渲染并暴露前面所有故事产出的系统）
