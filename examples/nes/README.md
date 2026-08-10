# Terminal NES Emulator（终端 NES 模拟器）

在终端里直接玩 NES 游戏：真正的 NES 模拟器（[jsnes](https://github.com/bfirsh/jsnes)，Apache-2.0），
真实 256×240 像素帧，通过 kitty / iTerm2 / sixel 图形协议渲染进 terminal。

## 一键启动

```bash
bun run run:nes:terminal
```

默认会加载 `roms/falling.nes`（[Falling](https://github.com/xram64/falling-nes)，MIT 协议，
作者授权自由分发，用于开箱即玩验证）。

## 玩你自己的（合法）游戏，比如原版魂斗罗

把你自己合法拥有的 .nes 文件放入 `examples/nes/roms/contra.nes`，先自检能否运行：

```bash
bun run check:nes:rom        # 校验 contra.nes 的 mapper 是否被 jsnes 支持
```

然后启动：

```bash
bun run run:nes:terminal
```

runner 会优先加载 `contra.nes`，并在启动时打印该 ROM 的 mapper 信息。
原版 NES《魂斗罗》使用 **Mapper 2**，已被内置 jsnes 核心支持，因此你的合法 ROM 放入后即为 1:1 原版。

也可以显式指定任意路径：

```bash
VUE_TUI_NES_ROM=/path/to/contra.nes bun run run:nes:terminal
```

> ⚠️ 版权提醒：仓库不包含任何商业游戏 ROM。请只运行你自己合法拥有的 ROM
> （自购卡带导出 / 官方授权文件）。

## 控制

| 终端按键            | NES 手柄        |
| ------------------- | --------------- |
| `←↑↓→` / `WASD`     | 方向键          |
| `Z` / `J`           | B（射击）       |
| `X` / `K`           | A（跳跃）       |
| `Enter`             | Start           |
| `Shift`             | Select          |
| `S`                 | 截图 + 分享到 X |
| `P`                 | 暂停模拟        |
| `Q` / `Ctrl+C`      | 退出            |

> 输入模型说明：终端只上报按下、不上报松开，因此本 runner 以「持续 keydown
> 视为按住、停止 keydown 约 0.7s 后自动松开」模拟手柄。方向键左右/上下互斥，
> 最后一次按键生效。按住方向键奔跑请一直按住不放。

## 分享到 X + 排行榜

游戏进行中按 `S`，一条龙：

1. **截图**：暂停模拟，截取当前 NES 画面（PNG，裁掉 NTSC 黑边）
2. **图片进剪贴板**：macOS 用 osascript / Linux 用 xclip 把截图复制到系统剪贴板
3. **唤起浏览器**：`open` / `xdg-open` 自动打开 **X 发帖页**（`x.com/intent/tweet`），文案、vue-tui 仓库链接、话题（`#vueTui #terminalUI #retroGaming`）已预填
4. **排行榜**：记录本地排行（`~/.vue-tui-nes/leaderboard.json`）并显示名次

> ⚠️ X 网页端不允许 intent 自动携带图片——浏览器打开后，在发帖框里按
> `Cmd/Ctrl+V` 把截图粘贴进去即可（图片已在剪贴板）。

```bash
VUE_TUI_NES_PLAYER=my-name bun run run:nes:terminal   # 自定义玩家名
```

## 每次启动随机游戏

把多个（自己合法拥有的）.nes 放进 `examples/nes/roms/`，然后：

```bash
VUE_TUI_NES_RANDOM=1 bun run run:nes:terminal
```

每次启动会从 roms 目录随机选一个 ROM（不同游戏 = 不同主角）。

## 画质

- 裁掉 NTSC overscan 黑边（真实 256×224 可见画面）
- 终端足够大时自动整数倍放大（1×/2×），最近邻采样锐利无模糊
- 小终端自动降级为精确适配

## 结构

- `nes-video-game.ts` — Vue 组件：jsnes 每帧 → 裁黑边 → RGBA → PNG → TVideo
- `nes-terminal.ts` — CLI runner（smoke + 交互，ROM 解析/随机/分享/排行榜）
- `share.ts` — 截图 + X 文案 + 本地排行榜
- `check-rom.ts` — ROM 兼容性自检（mapper 是否被 jsnes 支持）
- `input-flip-check.ts` / `share-check.ts` — 回归脚本
- `png.ts` — 纯 Node zlib PNG 编码 + 最近邻缩放
- `vendor/jsnes/` — jsnes 源码（Apache-2.0，含 LICENSE）
- `roms/` — 可免费分发的 homebrew ROM（附作者 LICENSE）

## 验证

```bash
bun run example:nes:smoke     # 加载 ROM → 模拟 120 帧 → 验证像素与 PNG
bun run check:nes:rom         # 自检某个 ROM 是否可被 jsnes 运行
bun run check:nes:input       # 验证键盘方向切换（无 keyup 场景）不会卡键
bun run check:nes:share       # 验证截图 + 文案 + 排行榜（不污染真实数据）
bun run check:nes:share-browser  # 验证 X intent URL + 图片进剪贴板（不真开浏览器）
```