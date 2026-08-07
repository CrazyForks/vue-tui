---
title: Mermaid 图渲染（TMermaidText）
description: 在终端里渲染 Mermaid flowchart / sequence / state diagram 的 ASCII 文本输出：beautiful-mermaid bridge 零配置用法、renderer-agnostic primitive 与自定义 renderer、流式 source 策略、依赖安装。
---

# Mermaid 图渲染（TMermaidText）

`TMermaidText` 在终端里把 Mermaid 源码渲染为 ASCII 文本图（flowchart / sequence / state diagram）。`TMermaid` 是它的短别名，适合 agent console 里直接展示结构图。组件本身**不依赖 Mermaid 引擎**：内置 `beautiful-mermaid` bridge 负责渲染，也可以传入你自己的 `renderer`。

## 依赖安装

组件本身零 npm 依赖，可以直接从 `@simon_he/vue-tui/vue` 或 `@simon_he/vue-tui/agent` 导入使用（传自定义 `renderer`）。**使用内置 beautiful-mermaid bridge 前先安装**：

```bash
pnpm add @simon_he/vue-tui vue

# 可选：内置 beautiful-mermaid 渲染桥
pnpm add beautiful-mermaid
```

> 未安装 `beautiful-mermaid` 时**不要**直接 import `@simon_he/vue-tui/mermaid` / `@simon_he/vue-tui/agent/mermaid`；请从 `@simon_he/vue-tui/vue` / `@simon_he/vue-tui/agent` 导入基础组件并显式传 `renderer`。

## 快速开始 A：内置 bridge 零配置

安装 `beautiful-mermaid` 后，从 bridge 入口导入，`final` 为 true 时自动渲染，无需传 renderer：

```vue
<script setup lang="ts">
import { TMermaidText } from "@simon_he/vue-tui/agent/mermaid";

const diagram = `graph TD
  Prompt --> Plan
  Plan --> ToolCall
  ToolCall --> Answer`;
</script>

<template>
  <TMermaidText :x="0" :y="0" :w="72" :content="diagram" />
</template>
```

浏览器 / DOM 场景从 `@simon_he/vue-tui/mermaid` 导入。

## 快速开始 B：基础组件 + 显式 renderer

不安装 `beautiful-mermaid` 时，从 `@simon_he/vue-tui/agent`（或 `/vue`）导入 renderer-agnostic primitive，并把内置 `beautifulMermaidRenderer` 作为 `renderer` 传入——这个 renderer 从 bridge 入口导出，使用同一套懒加载：

```vue
<script setup lang="ts">
import { TMermaidText } from "@simon_he/vue-tui/agent";
import { beautifulMermaidRenderer } from "@simon_he/vue-tui/agent/mermaid";

const diagram = `graph TD
  Prompt --> Plan
  Plan --> ToolCall
  ToolCall --> Answer`;
</script>

<template>
  <TMermaidText :x="0" :y="0" :w="72" :content="diagram" :renderer="beautifulMermaidRenderer" />
</template>
```

## 流式 Mermaid（AI 输出场景）

AI 输出 Mermaid fence 时经常先产生不完整源码：

```vue
<TMermaidText
  :x="0"
  :y="0"
  :w="72"
  :content="diagram"
  :streaming="message.streaming"
  :final="message.final"
/>
```

策略是 **source-first**：

- `streaming=true && final=false` 时只显示源码，不调用 renderer（避免对半截源码渲染）。
- 非 streaming 或 `final=true` 后：源码通过 size guard + eligibility guard 且 renderer 成功 → **原子替换**为渲染结果；否则保持源码显示。
- 复杂 Mermaid、超出 size guard、`shouldRenderSource` 返回 `false`、renderer 失败 / 超时 / 返回空白、缺少 renderer——都保持源码显示，不显示 loading/error/incomplete 文案（这些 prop 作为遗留兼容保留，当前不影响显示）。

## Props

| Prop                                                                                                               | 类型                        | 默认                          | 说明                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `x` / `y` / `w`                                                                                                    | `number`（必填）            | —                             | 渲染区域左上角与宽度                                                                                           |
| `h`                                                                                                                | `number`                    | 自适应                        | 固定高度；不传时按渲染行数自适应                                                                               |
| `content` / `code`                                                                                                 | `string`                    | —                             | Mermaid source；同时传入时 `code` 优先                                                                         |
| `final`                                                                                                            | `boolean`                   | `true`                        | source 是否已结束；`streaming=true && final=false` 只显示源码                                                  |
| `streaming`                                                                                                        | `boolean`                   | `false`                       | streaming 更新时用低优先级 frame task 合并重算                                                                 |
| `ascii`                                                                                                            | `boolean`                   | `false`                       | 使用纯 ASCII 而不是 Unicode box drawing（透传给 renderer）                                                     |
| `options`                                                                                                          | `TMermaidAsciiOptions`      | —                             | 传给 renderer 的 spacing/theme options；组件始终强制 `colorMode: "none"`                                       |
| `renderer`                                                                                                         | `TMermaidRenderer`          | —                             | 自定义 renderer（测试或替换 Mermaid engine）                                                                   |
| `shouldRenderSource`                                                                                               | `TMermaidRenderEligibility` | 见下                          | eligibility guard；返回 `false` 时保持源码。primitive 不传不限制；bridge 默认 `isSimpleMermaidFlowchartSource` |
| `loadingText` / `incompleteText` / `missingDependencyText` / `errorText` / `showErrorDetails` / `isTransientError` | —                           | 遗留兼容 prop，当前不影响显示 |

## 内置 bridge 的渲染边界

- 内置 wrapper 默认使用 **size guard + simple-flowchart-only guard**：`final=true` 后仅对简单 flowchart 尝试渲染。
- 复杂 Mermaid（sequence / state 等）、大 Mermaid、renderer 失败 / 超时 / 返回空白 → 保持源码显示。
- 需要限制自定义 renderer 只处理简单 flowchart 时，显式传 `shouldRenderSource={isSimpleMermaidFlowchartSource}`（从 `@simon_he/vue-tui/vue` 或 `@simon_he/vue-tui/agent` 导入）。
- 辅助函数：`isSimpleMermaidFlowchartSource`（eligibility guard）、`markMermaidRenderErrorFatal`（把渲染错误标记为 fatal，仍保持源码显示）。

## 注意：Markdown 里的 mermaid fence

Markdown 里的 `mermaid` code fence 当前只保留 `code_block.language` metadata，**尚未自动走 `TMermaidText` 的 async render/cache 路径**。需要在 markdown 里渲染结构图时，请显式使用 `TMermaidText` / `TMermaid` 组件渲染，或用自定义 markdown 处理。

## Related Pages

- [终端图片渲染（Kitty 图形协议）](/guide/terminal-image-rendering)（mermaid 也可经 `TAgentTerminalGraphic` 输出为图片）
- [Markdown Transcript](/guide/markdown-transcript)
- [Components](/components)（`TMermaid` / `TMermaidText` 段）
- [Agent Console](/agent-console)
