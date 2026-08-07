---
title: 终端视频渲染（TVideo）
description: 在终端里播放视频：Kitty / iTerm2 图形协议下的 PNG 视频帧、无图形能力时的动态 ASCII 降级、FFmpeg 与 yt-dlp frame source、依赖安装与完整用法。
---

# 终端视频渲染（TVideo）

`TVideo` 是实验性的 terminal video 组件：在支持图形协议的终端（Kitty / iTerm2）里把视频渲染为 PNG 帧序列，在普通终端里自动降级为**动态 ASCII 视频**，功能完整、无需改代码。

```bash
# 浏览器 + 终端两种 showcase 都可用（Video Tab）
bun run showcase
bun run showcase:terminal
```

## 渲染策略

| 终端能力                        | 输出                                                                        |
| ------------------------------- | --------------------------------------------------------------------------- |
| Kitty / iTerm2（图形协议）      | PNG 帧，默认 12fps；自动像素尺寸保持 cell 区域比例并限制在 640×360          |
| 普通 Unicode 终端（无图形协议） | `gray8` raw 帧，最高 10fps，映射为纯 ASCII 文本（动态低保真视频，功能完整） |
| Sixel 终端                      | 尚未接入 Sixel video encoder，走 ASCII 降级                                 |

- ASCII 路径按终端 cell 约 1:2 的宽高比采样：每行请求约一半 cell 数的灰度样本，再把每个亮度 glyph 横向绘制两次，保持视频比例。
- 帧泵只保留 latest frame，被覆盖的帧不会进入渲染阶段；连续重复帧在转换前去重。
- 暂停、隐藏、离开 viewport、滚动期间和卸载都会 abort decoder；恢复时用最后一帧的近似时间戳继续 seek。

## 依赖安装

`TVideo` 组件本身 browser-safe，零 npm 依赖。**真正需要的是系统可执行文件**，Node 侧 adapter 从 `@simon_he/vue-tui/experimental/video/node` 单独导入，并在真正开始播放时才动态加载 `node:child_process`：

```bash
# 核心库
pnpm add @simon_he/vue-tui vue

# 系统工具（不是 npm 包，二选一或都要）
brew install ffmpeg        # 本地文件 / HTTP 视频解码必需
brew install yt-dlp        # 解析 YouTube 等视频页面时需要
```

- 两者都可以通过对应 path option 指定可执行文件（`ffmpegPath` / `ytDlpPath`），不会在安装包时下载二进制。
- 按当前 [yt-dlp EJS 安装说明](https://github.com/yt-dlp/yt-dlp/wiki/EJS)，完整 YouTube 支持还需要 `yt-dlp-ejs` 和受支持的 JavaScript runtime；Demo 推荐安装默认启用的 Deno 2.3+。

## 快速开始 A：本地文件 / HTTP 视频

`src` 支持本地路径、`file:` URL 或 `http(s)` 视频链接。用 `createFfmpegVideoFrameSource()` 创建 frame source：

```ts
import { TVideo } from "@simon_he/vue-tui/experimental";
import { createFfmpegVideoFrameSource } from "@simon_he/vue-tui/experimental/video/node";

const videoFrames = createFfmpegVideoFrameSource();

h(TVideo, {
  x: 0,
  y: 0,
  w: 60,
  h: 18,
  src: "https://example.com/video.mp4",
  frameSource: videoFrames,
  maxFps: 12,
  controls: true,
  controlsLayout: "compact",
  durationMs: 60_000,
});
```

要点：

- `createFfmpegVideoFrameSource()` 先用 `maxFps` 降帧，再用 fast bilinear 缩放并 pad 到受控尺寸。
- 普通 HTTP MP4 需要服务端支持 Range，或使用把 `moov` 放在文件头的 faststart 文件。
- 直播源用 `createFfmpegVideoFrameSource({ live: true })`，避免 input readrate 对实时流丢包。
- adapter 只允许本地 `file` 或 `http(s)` 输入协议，且始终 `shell: false` 把 `src` 作为单独 argv 传递。

## 快速开始 B：YouTube 视频

YouTube `watch` URL 是网页而不是媒体流，不能直接交给 FFmpeg。`createYtDlpVideoFrameSource()` 会先让 `yt-dlp` 解析一个 video-only HTTP(S) 流，再把临时 URL 和必要的 HTTP headers 交给同一 FFmpeg 管线：

```ts
import { TVideo } from "@simon_he/vue-tui/experimental";
import { createYtDlpVideoFrameSource } from "@simon_he/vue-tui/experimental/video/node";

const youtubeFrames = createYtDlpVideoFrameSource({
  ytDlpPath: "yt-dlp",
});

h(TVideo, {
  x: 0,
  y: 0,
  w: 60,
  h: 18,
  src: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
  frameSource: youtubeFrames,
  maxFps: 12,
  controls: true,
  controlsLayout: "cinema",
});
```

要点：

- 默认根据 `TVideo` 的实际解码尺寸和 `maxFps` 自适应选择 source：常见终端区域通常选 360p、至多 30fps 的源，再由 FFmpeg 降到最终 PNG/ASCII 尺寸和播放帧率。`maxSourceHeight` 只是可选上限。
- 已解析的媒体直链会短期复用（TTL 5 分钟），暂停、seek、换速不会重复启动 yt-dlp。
- 暂停、滚动或卸载时，解析进程与 FFmpeg 都会被终止。
- 只应播放你有权访问和再利用的内容。

## 播放控制

开启 `controls` 后，点击视频画面切换暂停/继续。`controlsLayout` 支持 `"compact"`（底部 1 cell 单行：播放/暂停、进度条、1×/2×/3× 倍速）和 `"cinema"`（底部 2 cells 双行布局）：

- 鼠标可拖动进度条；聚焦视频区域后按 Enter 播放/暂停、Up/Down 切换倍速，CLI 下也支持 Space 和数字 1/2/3。
- 进度拖动期间只更新预览并停止旧 decoder，松手后才按目标时间启动一次新 decoder；暂停状态 seek 只解码一帧作为预览。
- `paused` / `playbackRate` 不绑定时由组件内部维护；使用 `v-model:paused` / `v-model:playback-rate` 时由父组件控制。
- 可 seek 的进度条需要 `durationMs`，或由 frame source 在帧上提供 `durationMs`。
- FFmpeg 在 2×/3× 时仍按墙钟限制到 `maxFps`，不会成倍增加 PNG/ASCII 转换。

## Props

| Prop                         | 类型                        | 默认                   | 说明                                                  |
| ---------------------------- | --------------------------- | ---------------------- | ----------------------------------------------------- |
| `x` / `y` / `w` / `h`        | `number`（必填）            | —                      | 视频占用的 cell rect                                  |
| `src`                        | `string`（必填）            | —                      | 本地路径 / `file:` / `http(s)` 视频链接 / YouTube URL |
| `frameSource`                | `TVideoFrameSource`（必填） | —                      | 帧源（FFmpeg / yt-dlp / 自定义），见下                |
| `maxFps`                     | `number`                    | 12（PNG）/ 10（ASCII） | 播放帧率上限                                          |
| `paused`                     | `boolean`                   | 内部维护               | 受控暂停；配 `v-model:paused`                         |
| `playbackRate`               | `1 \| 2 \| 3`               | 内部维护               | 受控倍速；配 `v-model:playback-rate`                  |
| `controls`                   | `boolean`                   | `false`                | 显示控制栏                                            |
| `controlsLayout`             | `"compact" \| "cinema"`     | `"compact"`            | 控制栏布局                                            |
| `durationMs`                 | `number`                    | `undefined`            | 视频总时长（可 seek 进度条需要）                      |
| `loop`                       | `boolean`                   | `false`                | 循环播放                                              |
| `pixelWidth` / `pixelHeight` | `number`                    | `undefined`            | 可选解码尺寸上限                                      |
| `fallback`                   | `string`                    | `"[video]"`            | 渲染器初始化前/出错时显示的文本                       |
| `zIndex`                     | `number`                    | `0`                    | Kitty placement z-index                               |

## Events

| Event                                   | Payload                                                                               | 说明              |
| --------------------------------------- | ------------------------------------------------------------------------------------- | ----------------- |
| `frame`                                 | `{ timestampMs, pixelWidth, pixelHeight, droppedFrames, durationMs?, playbackRate? }` | 每帧渲染后触发    |
| `seek`                                  | `{ timestampMs, durationMs? }`                                                        | seek 触发         |
| `ended`                                 | —                                                                                     | 播放到结尾        |
| `error`                                 | `unknown`                                                                             | 解码/渲染错误     |
| `update:paused` / `update:playbackRate` | `boolean` / `1\|2\|3`                                                                 | 配合 v-model 受控 |

## 自定义 frame source

`frameSource` 是一个 `(context) => AsyncIterable<TVideoFrame>` 函数，context 提供：

```ts
type TVideoFrameSourceContext = {
  src: string;
  signal: AbortSignal; // 暂停/隐藏/滚动/卸载时 abort
  maxFps: number;
  pixelWidth: number;
  pixelHeight: number;
  startAtMs: number; // 定位播放时间
  playbackRate: 1 | 2 | 3;
  loop: boolean;
  preferredFormat: "png" | "gray8"; // 请求的帧格式
};
```

- `preferredFormat` 请求 `png` 或 `gray8`，自定义 frame source 应按请求返回对应帧：
  - `png` 帧：`{ format?: "png", png: Uint8Array, timestampMs?, durationMs?, pixelWidth?, pixelHeight? }`
  - `gray8` 帧：`{ format: "gray8", pixels: Uint8Array, pixelWidth, pixelHeight, ... }`
- 组件通过 `signal` 在暂停/隐藏/滚动/卸载时 abort decoder，自定义 source 应及时响应并 settle。
- Kitty 使用固定 image/placement id，并由 stdout renderer 在同一 terminal frame 内完成旧帧清理和新帧绘制。

## 常见问题

### 只有 ASCII 视频，没有真彩画面

- 终端不支持图形协议（Kitty / Ghostty / WezTerm / foot / iTerm2 支持；xterm 只有 sixel，未接入 video encoder，走 ASCII）。
- 在 tmux / screen / zellij 里运行：退出复用器，或 tmux 开 `VUE_TUI_GRAPHICS_TMUX_PASSTHROUGH=1`（见 [终端图片渲染](/guide/terminal-image-rendering)）。
- stdout 不是 TTY（管道 / CI）。

### YouTube 打不开 / 解析失败

- 确认系统有 `yt-dlp`，且版本支持目标站点；必要时用 `ytDlpPath` 指定。
- 完整 YouTube 支持需要 `yt-dlp-ejs` + 受支持的 JavaScript runtime（推荐 Deno 2.3+），见 [yt-dlp EJS 安装说明](https://github.com/yt-dlp/yt-dlp/wiki/EJS)。
- 只播放你有权访问的内容。

### 本地 HTTP MP4 卡住 / 无法 seek

- 服务端需要支持 Range 请求，或用 `moov` 在文件头的 faststart 文件。
- 卡顿时可调低 `maxFps` / `pixelWidth` / `pixelHeight`。

## Related Pages

- [终端图片渲染（Kitty 图形协议）](/guide/terminal-image-rendering)（同一图形协议链路）
- [Markdown 数学公式渲染](/guide/markdown-math)
- [Platform Contracts](/platform-contracts)（协议矩阵、各组件降级表）
- [Components](/components)（`TVideo` 段）
