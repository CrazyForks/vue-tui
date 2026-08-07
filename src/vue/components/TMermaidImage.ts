import type { ExtractPublicPropTypes, PropType } from "vue";
import type { Style } from "../../core/types.js";
import type {
  Rect,
  TerminalKeyboardEvent,
  TerminalPointerEvent,
} from "../../events/manager/types.js";
import {
  computed,
  defineComponent,
  getCurrentInstance,
  h,
  inject,
  onBeforeUnmount,
  shallowRef,
  watch,
} from "vue";
import { EventZIndexContextKey } from "../context.js";
import {
  createTerminalGraphicPngSequence,
  getTerminalGraphicsOutput,
  getTerminalGraphicsOutputVersion,
  stableTerminalGraphicNumericId,
  subscribeTerminalGraphicsOutput,
} from "../../renderer/terminal-graphics.js";
import { useLayout } from "../composables/use-layout.js";
import { useRenderNode } from "../composables/use-render-node.js";
import { useTerminal } from "../composables/use-terminal.js";
import { useTerminalNode } from "../composables/use-terminal-node.js";
import { useVisibility } from "../composables/use-visibility.js";
import { intersectRect, translateRect } from "../utils/rect.js";
import {
  padEndByCells,
  repeatChar,
  sanitizeInlineText,
  sanitizeTextBlock,
  sliceByCells,
  sliceByCellsRange,
  spaces,
  textCellWidth,
  withTextWidthProvider,
} from "../utils/text.js";
import {
  getCachedMermaidImage,
  getMermaidImage,
  isMermaidImageRendererReady,
  loadMermaidImageRenderer,
  normalizeMermaidImageOptions,
  resolveMermaidImageColor,
  subscribeMermaidImage,
  type TuiMermaidImageCells,
  type TuiMermaidImageOptions,
  type TuiMermaidImageRasterizer,
} from "../mermaid/mermaid-image.js";

export type TMermaidImageCopyPayload = Readonly<{
  text: string;
  ok: boolean;
  error?: unknown;
}>;

type TMermaidImageBoxChars = Readonly<{
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
}>;

type TMermaidImageFit = Readonly<{
  displayW: number;
  displayH: number;
}>;

const UNICODE_MERMAID_IMAGE_BOX_CHARS: TMermaidImageBoxChars = Object.freeze({
  tl: "┌",
  tr: "┐",
  bl: "└",
  br: "┘",
  h: "─",
  v: "│",
});

const ASCII_MERMAID_IMAGE_BOX_CHARS: TMermaidImageBoxChars = Object.freeze({
  tl: "+",
  tr: "+",
  bl: "+",
  br: "+",
  h: "-",
  v: "|",
});

const DEFAULT_MERMAID_IMAGE_COPIED_DURATION_MS = 1200;
const DEFAULT_MERMAID_IMAGE_MAX_RENDER_SOURCE_CHARS = 20_000;
const DEFAULT_MERMAID_IMAGE_MAX_RENDER_SOURCE_LINES = 400;

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const TERMINAL_ESCAPE_RE = new RegExp(
  [
    `${ESC}\\][\\s\\S]*?(?:${BEL}|${ESC}\\\\)`,
    `${ESC}[PX^_][\\s\\S]*?${ESC}\\\\`,
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    `${ESC}[@-Z\\\\-_]`,
  ].join("|"),
  "g",
);

function stripTerminalEscapes(value: string): string {
  return value.replace(TERMINAL_ESCAPE_RE, "");
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function countLinesUpTo(value: string, max: number): number {
  if (max <= 0) return 0;

  let lines = 1;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code !== 10 && code !== 13) continue;

    lines++;

    if (code === 13 && value.charCodeAt(index + 1) === 10) {
      index++;
    }

    if (lines > max) return lines;
  }

  return lines;
}

function splitRenderedOutput(value: string): readonly string[] {
  const normalized = sanitizeTextBlock(
    stripTerminalEscapes(String(value ?? "")).replace(/\r\n?/g, "\n"),
  );
  const lines = normalized.split("\n");
  return lines.length ? lines : [""];
}

function fitImageCells(
  cells: TuiMermaidImageCells,
  maxW: number,
  maxH: number,
): TMermaidImageFit | null {
  if (maxW <= 0 || maxH <= 0) return null;
  let w = Math.max(1, Math.floor(cells.widthCells));
  let h = Math.max(1, Math.floor(cells.heightCells));
  if (w > maxW) {
    h = Math.max(1, Math.round((h * maxW) / w));
    w = maxW;
  }
  if (h > maxH) {
    w = Math.max(1, Math.round((w * maxH) / h));
    h = maxH;
  }
  return { displayW: Math.max(1, w), displayH: Math.max(1, h) };
}

export const tMermaidImageProps = {
  x: { type: Number, required: true },
  y: { type: Number, required: true },
  w: { type: Number, required: true },
  h: { type: Number, default: undefined },
  zIndex: { type: Number, default: 0 },
  content: { type: String, default: "" },
  code: { type: String, default: undefined },
  style: { type: Object as PropType<Style>, default: undefined },
  clear: { type: Boolean, default: true },
  final: { type: Boolean, default: true },
  streaming: { type: Boolean, default: false },
  // Image pipeline. Without a renderer the built-in lazy rasterizer
  // (beautiful-mermaid SVG + @resvg/resvg-js) is used; when graphics are
  // unsupported or the rasterizer is missing, the raw source is shown.
  renderer: {
    type: Function as PropType<TuiMermaidImageRasterizer>,
    default: undefined,
  },
  cellWidthPx: { type: Number, default: undefined },
  cellHeightPx: { type: Number, default: undefined },
  scale: { type: Number, default: undefined },
  bg: { type: String, default: undefined },
  fg: { type: String, default: undefined },
  maxWidthCells: { type: Number, default: undefined },
  maxHeightCells: { type: Number, default: undefined },
  padding: { type: Number, default: undefined },
  // Box chrome (mirrors TMermaidText).
  box: { type: Boolean, default: true },
  title: { type: String, default: "mermaid" },
  copyButton: { type: Boolean, default: true },
  copyText: { type: String, default: "copy" },
  copiedText: { type: String, default: "copied" },
  copiedDurationMs: { type: Number, default: DEFAULT_MERMAID_IMAGE_COPIED_DURATION_MS },
  renderTimeoutMs: { type: Number, default: 0 },
  maxRenderSourceChars: { type: Number, default: DEFAULT_MERMAID_IMAGE_MAX_RENDER_SOURCE_CHARS },
  maxRenderSourceLines: { type: Number, default: DEFAULT_MERMAID_IMAGE_MAX_RENDER_SOURCE_LINES },
  // Clicking the diagram (or the copy button) copies the full raw mermaid source.
  copyOnClick: { type: Boolean, default: true },
  ascii: { type: Boolean, default: false },
} as const;

export type TMermaidImageProps = ExtractPublicPropTypes<typeof tMermaidImageProps>;

export const TMermaidImage = defineComponent({
  name: "TMermaidImage",
  props: tMermaidImageProps,
  emits: {
    copy: (_payload: TMermaidImageCopyPayload) => true,
  },
  setup(props, { emit }) {
    const instance = getCurrentInstance();
    const terminalContext = useTerminal();
    const { terminal, defaultStyle, scheduler, widthProvider } = terminalContext;
    const layout = useLayout();
    const { visible, rootProps } = useVisibility();
    const parentEventZ = inject(EventZIndexContextKey, computed(() => 0) as any);

    const imageCells = shallowRef<TuiMermaidImageCells | null>(null);
    const documentVersion = shallowRef(0);
    const copied = shallowRef(false);

    let builtOnce = false;
    let renderVersion = 0;
    let alive = true;
    const frameTaskId = `TMermaidImage:${instance?.uid ?? "unknown"}:mermaid-image`;
    const uid = instance?.uid ?? 0;
    let copiedTimer: ReturnType<typeof setTimeout> | null = null;
    let copyRequestVersion = 0;
    let activeGraphicId: string | null = null;

    const source = computed(() => props.code ?? props.content ?? "");

    const waitingForStreamingSourceToFinish = computed(() => props.streaming && !props.final);

    const graphicsOutputVersion = shallowRef(getTerminalGraphicsOutputVersion(terminal));
    const graphicsOutput = computed(() => {
      // `getTerminalGraphicsOutput` reads a plain registry (not reactive);
      // depend on the version ref so this computed invalidates when a
      // graphics output is (un)registered.
      void graphicsOutputVersion.value;
      return getTerminalGraphicsOutput(terminal);
    });

    const graphicsProtocol = computed(() => {
      const output = graphicsOutput.value;
      if (!output?.capabilities.supported) return null;
      const protocol = output.capabilities.preferredProtocol;
      if (protocol === "kitty" || protocol === "iterm2") return protocol;
      return null;
    });

    function bump(): void {
      documentVersion.value++;
    }

    function clearCopiedTimer(): void {
      if (copiedTimer == null) return;
      clearTimeout(copiedTimer);
      copiedTimer = null;
    }

    function setCopied(next: boolean, repaint = true): void {
      if (!next) clearCopiedTimer();
      if (copied.value === next) return;
      copied.value = next;
      if (repaint) bump();
    }

    function resetCopyFeedback(repaint = true): void {
      copyRequestVersion++;
      setCopied(false, repaint);
    }

    function showCopiedFeedback(): void {
      clearCopiedTimer();

      const duration = normalizeNonNegativeInt(
        props.copiedDurationMs,
        DEFAULT_MERMAID_IMAGE_COPIED_DURATION_MS,
      );
      if (duration <= 0) {
        setCopied(false);
        return;
      }

      setCopied(true);
      copiedTimer = setTimeout(() => {
        copiedTimer = null;
        if (!alive) return;
        setCopied(false);
      }, duration);
    }

    function queueClearGraphic(): void {
      if (activeGraphicId == null) return;
      const id = activeGraphicId;
      activeGraphicId = null;
      try {
        graphicsOutput.value?.clear?.(id);
      } catch {
        // Best-effort cleanup; raw graphics must not affect text rendering.
      }
    }

    const hasBox = computed(() => props.box !== false);

    const normalizedWidth = computed(() => {
      const width = Math.floor(Number(props.w));
      return Number.isFinite(width) ? Math.max(0, width) : 0;
    });

    const reservesBoxRows = computed(() => hasBox.value && normalizedWidth.value >= 2);

    const boxChars = computed<TMermaidImageBoxChars>(() =>
      props.ascii ? ASCII_MERMAID_IMAGE_BOX_CHARS : UNICODE_MERMAID_IMAGE_BOX_CHARS,
    );

    const sourceLines = computed<readonly string[]>(() => splitRenderedOutput(source.value));

    const currentStyle = computed<Style>(() => props.style ?? defaultStyle.value);

    const innerWidth = computed(() => {
      const w = normalizedWidth.value;
      return reservesBoxRows.value ? Math.max(0, w - 2) : w;
    });

    const fixedInnerHeight = computed(() => {
      if (props.h == null) return 0;
      const h = Math.floor(Number(props.h));
      if (!Number.isFinite(h)) return 0;
      const value = Math.max(0, h);
      return reservesBoxRows.value ? Math.max(0, value - 2) : value;
    });

    const autoHeight = computed(() => props.h == null);

    const displayFit = computed<TMermaidImageFit | null>(() => {
      const cells = imageCells.value;
      if (!cells) return null;
      if (autoHeight.value) {
        return fitImageCells(cells, innerWidth.value, Number.MAX_SAFE_INTEGER);
      }
      return fitImageCells(cells, innerWidth.value, fixedInnerHeight.value);
    });

    const contentHeight = computed(() => {
      if (!autoHeight.value) return fixedInnerHeight.value;
      return displayFit.value?.displayH ?? Math.max(1, sourceLines.value.length);
    });

    const fullHeight = computed(() => {
      if (props.h != null) {
        const h = Math.floor(Number(props.h));
        return Number.isFinite(h) ? Math.max(0, h) : 0;
      }
      return reservesBoxRows.value ? contentHeight.value + 2 : contentHeight.value;
    });

    const fullRect = computed<Rect>(() => {
      return translateRect(
        { x: props.x, y: props.y, w: props.w, h: fullHeight.value },
        layout.originX,
        layout.originY,
      );
    });

    const absRect = computed<Rect>(() => {
      const translated = fullRect.value;
      if (!layout.clipRect) return translated;
      return intersectRect(translated, layout.clipRect) ?? { x: 0, y: 0, w: 0, h: 0 };
    });

    const copyLabel = computed(() => (copied.value ? props.copiedText : props.copyText));

    function cellWidth(value: string): number {
      return withTextWidthProvider(widthProvider, () => textCellWidth(value));
    }

    function sliceCells(text: string, maxCells: number): string {
      return withTextWidthProvider(widthProvider, () => sliceByCells(text, maxCells));
    }

    function sliceCellsRange(text: string, startCells: number, endCells: number): string {
      return withTextWidthProvider(widthProvider, () =>
        sliceByCellsRange(text, startCells, endCells),
      );
    }

    function padCells(text: string, width: number): string {
      return withTextWidthProvider(widthProvider, () => padEndByCells(text, width));
    }

    function resolveImageOptions(): TuiMermaidImageOptions {
      const resolvedFg = props.fg ?? resolveMermaidImageColor(currentStyle.value.fg) ?? undefined;
      return normalizeMermaidImageOptions({
        cellWidthPx: props.cellWidthPx,
        cellHeightPx: props.cellHeightPx,
        scale: props.scale,
        bg: props.bg,
        fg: resolvedFg,
        maxWidthCells: props.maxWidthCells,
        maxHeightCells: props.maxHeightCells,
        padding: props.padding,
      });
    }

    function shouldSkipRenderForSize(code: string): boolean {
      const maxChars = normalizeNonNegativeInt(
        props.maxRenderSourceChars,
        DEFAULT_MERMAID_IMAGE_MAX_RENDER_SOURCE_CHARS,
      );
      if (maxChars > 0 && code.length > maxChars) return true;

      const maxLines = normalizeNonNegativeInt(
        props.maxRenderSourceLines,
        DEFAULT_MERMAID_IMAGE_MAX_RENDER_SOURCE_LINES,
      );
      if (maxLines > 0 && countLinesUpTo(code, maxLines) > maxLines) return true;

      return false;
    }

    async function rasterizeWithTimeout(
      code: string,
      options: TuiMermaidImageOptions,
    ): Promise<TuiMermaidImageCells | null> {
      const timeoutMs = normalizeNonNegativeInt(props.renderTimeoutMs, 0);
      if (timeoutMs <= 0) return await getMermaidImage(code, options);

      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        return await Promise.race([
          getMermaidImage(code, options),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), timeoutMs);
          }),
        ]);
      } finally {
        if (timer != null) clearTimeout(timer);
      }
    }

    async function renderImage(version: number): Promise<void> {
      const code = source.value;
      if (!code.trim()) {
        if (!alive || version !== renderVersion) return;
        imageCells.value = null;
        bump();
        return;
      }

      if (waitingForStreamingSourceToFinish.value || shouldSkipRenderForSize(code)) {
        if (!alive || version !== renderVersion) return;
        imageCells.value = null;
        bump();
        return;
      }

      // Source-first invariant: while the image is pending, keep the raw source
      // visible so the cell area is never blank.
      imageCells.value = null;
      bump();

      const protocol = graphicsProtocol.value;
      if (!protocol) {
        // Terminal has no graphics protocol: stay on raw source text.
        return;
      }

      const options = resolveImageOptions();
      const cached = getCachedMermaidImage(code, options);
      if (cached) {
        if (!alive || version !== renderVersion) return;
        imageCells.value = cached;
        bump();
        return;
      }

      if (!isMermaidImageRendererReady()) {
        void loadMermaidImageRenderer().then((ready) => {
          if (!alive || version !== renderVersion || !ready) return;
          void renderImage(version);
        });
        return;
      }

      const result = await rasterizeWithTimeout(code, options);
      if (!alive || version !== renderVersion) return;
      imageCells.value = result;
      bump();
    }

    function scheduleRender(): void {
      const version = ++renderVersion;

      resetCopyFeedback(false);
      imageCells.value = null;

      if (waitingForStreamingSourceToFinish.value) {
        builtOnce = true;
        scheduler.cancelFrameTask?.(frameTaskId);
        bump();
        return;
      }

      if (!builtOnce || !props.streaming) {
        builtOnce = true;
        void renderImage(version);
        return;
      }

      const accepted = scheduler.queueFrameTask({
        id: frameTaskId,
        reason: "stream",
        priority: "low",
        sync: false,
        run: () => {
          if (!alive) return;
          if (version !== renderVersion) return;
          void renderImage(version);
        },
      });
      if (accepted === false) {
        void renderImage(version);
      }
    }

    watch(
      [
        source,
        () => props.renderer,
        () => props.cellWidthPx,
        () => props.cellHeightPx,
        () => props.scale,
        () => props.bg,
        () => props.fg,
        () => props.maxWidthCells,
        () => props.maxHeightCells,
        () => props.padding,
        () => props.streaming,
        () => props.final,
        () => props.maxRenderSourceChars,
        () => props.maxRenderSourceLines,
        graphicsOutputVersion,
      ],
      () => {
        scheduleRender();
      },
      { immediate: true, deep: true },
    );

    const unsubscribeMermaidImage = subscribeMermaidImage(() => {
      if (!alive) return;
      // Another instance may have rasterized the same source; re-check the cache.
      scheduleRender();
    });

    const unsubscribeGraphicsOutput = subscribeTerminalGraphicsOutput(terminal, () => {
      if (!alive) return;
      graphicsOutputVersion.value = getTerminalGraphicsOutputVersion(terminal);
      scheduleRender();
    });

    onBeforeUnmount(() => {
      alive = false;
      renderVersion++;
      clearCopiedTimer();
      queueClearGraphic();
      unsubscribeMermaidImage();
      unsubscribeGraphicsOutput();
      scheduler.cancelFrameTask?.(frameTaskId);
    });

    type HeaderSegment = Readonly<{
      text: string;
      start: number;
      cells: number;
    }>;

    function canDrawBox(width: number, height: number): boolean {
      return hasBox.value && Math.floor(width) >= 2 && Math.floor(height) >= 2;
    }

    function headerCopySegment(width: number): HeaderSegment | null {
      if (!hasBox.value || !props.copyButton) return null;

      const rowWidth = Math.max(0, Math.floor(width));
      if (rowWidth < 4) return null;

      const label = sanitizeInlineText(copyLabel.value);
      if (!label) return null;

      const maxCells = Math.max(0, rowWidth - 2);
      const text = sliceCells(` ${label} `, maxCells);
      const cells = cellWidth(text);
      if (!text || cells <= 0) return null;

      return {
        text,
        start: Math.max(1, rowWidth - cells - 1),
        cells,
      };
    }

    function headerTitleSegment(width: number, copy: HeaderSegment | null): HeaderSegment | null {
      if (!hasBox.value) return null;

      const rowWidth = Math.max(0, Math.floor(width));
      if (rowWidth < 4) return null;

      const title = sanitizeInlineText(props.title);
      if (!title) return null;

      const titleStart = 1;
      const titleEnd = copy ? Math.max(titleStart, copy.start - 1) : rowWidth - 1;
      const maxCells = Math.max(0, titleEnd - titleStart);
      if (maxCells <= 0) return null;

      const text = sliceCells(` ${title} `, maxCells);
      const cells = cellWidth(text);
      if (!text || cells <= 0) return null;

      return {
        text,
        start: titleStart,
        cells,
      };
    }

    function overlayCells(row: string, segment: HeaderSegment, width: number): string {
      const rowWidth = Math.max(0, Math.floor(width));
      const start = Math.max(0, Math.floor(segment.start));
      if (rowWidth <= 1 || start >= rowWidth - 1 || segment.cells <= 0) return row;

      const maxCells = Math.max(0, rowWidth - 1 - start);
      const text = sliceCells(segment.text, maxCells);
      const cells = cellWidth(text);
      if (!text || cells <= 0) return row;

      return `${sliceCells(row, start)}${text}${sliceCellsRange(row, start + cells, rowWidth)}`;
    }

    function boxRow(rowIndex: number, width: number, height: number): string {
      const rowWidth = Math.max(0, Math.floor(width));
      const rowHeight = Math.max(0, Math.floor(height));

      if (!canDrawBox(rowWidth, rowHeight)) {
        return contentLine(rowIndex, rowWidth, props.clear);
      }

      const chars = boxChars.value;
      const innerW = Math.max(0, rowWidth - 2);

      if (rowIndex === 0) {
        let row = `${chars.tl}${repeatChar(chars.h, innerW)}${chars.tr}`;
        const copy = headerCopySegment(rowWidth);
        const title = headerTitleSegment(rowWidth, copy);

        if (title) row = overlayCells(row, title, rowWidth);
        if (copy) row = overlayCells(row, copy, rowWidth);

        return row;
      }

      if (rowIndex === rowHeight - 1) {
        return `${chars.bl}${repeatChar(chars.h, innerW)}${chars.br}`;
      }

      return `${chars.v}${contentLine(rowIndex - 1, innerW, true)}${chars.v}`;
    }

    function contentLine(rowIndex: number, width: number, pad: boolean): string {
      const showImage =
        imageCells.value != null && displayFit.value != null && graphicsProtocol.value != null;
      const src = showImage ? spaces(width) : (sourceLines.value[rowIndex] ?? "");
      const clipped = sliceCells(src, width);
      return pad ? padCells(clipped, width) : clipped;
    }

    function innerRectFrom(full: Rect): Rect {
      const x = Math.floor(full.x) + (reservesBoxRows.value ? 1 : 0);
      const y = Math.floor(full.y) + (reservesBoxRows.value ? 1 : 0);
      const w = Math.max(0, Math.floor(full.w) - (reservesBoxRows.value ? 2 : 0));
      const h = Math.max(0, Math.floor(full.h) - (reservesBoxRows.value ? 2 : 0));
      return { x, y, w, h };
    }

    function queueImageGraphic(full: Rect, fit: TMermaidImageFit): void {
      const protocol = graphicsProtocol.value;
      const cells = imageCells.value;
      if (!protocol || !cells) {
        queueClearGraphic();
        return;
      }

      const inner = innerRectFrom(full);
      if (inner.w <= 0 || inner.h <= 0) {
        queueClearGraphic();
        return;
      }

      const offsetX = inner.w > fit.displayW ? Math.floor((inner.w - fit.displayW) / 2) : 0;
      const rect = {
        x: inner.x + offsetX,
        y: inner.y,
        w: fit.displayW,
        h: fit.displayH,
      };
      const imageId = stableTerminalGraphicNumericId(`mermaid-image:${uid}:${renderVersion}:img`);
      const placementId = stableTerminalGraphicNumericId(
        `mermaid-image:${uid}:${renderVersion}:plc`,
      );
      const built = createTerminalGraphicPngSequence({
        protocol,
        base64: cells.base64,
        imageId,
        placementId,
        cols: cells.widthCells,
        rows: cells.heightCells,
        sourceWidth: cells.naturalWidth,
        sourceHeight: cells.naturalHeight,
        placementColumns: fit.displayW,
        placementRows: fit.displayH,
        rect,
        fullRect: rect,
        zIndex: -1,
        fallback: source.value,
      });
      if (!built) {
        queueClearGraphic();
        return;
      }

      const id = `mermaid-image:${uid}:${renderVersion}`;
      const output = graphicsOutput.value;
      if (!output) {
        queueClearGraphic();
        return;
      }

      if (activeGraphicId != null && activeGraphicId !== id) {
        try {
          output.clear?.(activeGraphicId);
        } catch {
          // Best-effort cleanup.
        }
        activeGraphicId = null;
      }

      const accepted = output.queue({
        id,
        x: rect.x,
        y: rect.y,
        w: fit.displayW,
        h: fit.displayH,
        protocol,
        sequence: built.sequence,
        resizeSequence: built.resizeSequence,
        clearSequence: built.clearSequence,
        fallbackText: source.value,
      });
      if (accepted) {
        activeGraphicId = id;
      } else {
        queueClearGraphic();
      }
    }

    const copyHitRect = computed<Rect>(() => {
      const full = fullRect.value;
      if (!visible.value || !props.copyButton || !canDrawBox(full.w, full.h)) {
        return { x: 0, y: 0, w: 0, h: 0 };
      }

      const copy = headerCopySegment(Math.max(0, Math.floor(full.w)));
      if (!copy) return { x: 0, y: 0, w: 0, h: 0 };

      const raw = {
        x: Math.floor(full.x) + copy.start,
        y: Math.floor(full.y),
        w: copy.cells,
        h: 1,
      };

      if (!layout.clipRect) return raw;
      return intersectRect(raw, layout.clipRect) ?? { x: 0, y: 0, w: 0, h: 0 };
    });

    const contentHitRect = computed<Rect>(() => {
      if (!visible.value || !props.copyOnClick) return { x: 0, y: 0, w: 0, h: 0 };
      const full = fullRect.value;
      if (full.w <= 0 || full.h <= 0) return { x: 0, y: 0, w: 0, h: 0 };
      const inner = innerRectFrom(full);
      if (inner.w <= 0 || inner.h <= 0) return { x: 0, y: 0, w: 0, h: 0 };
      if (!layout.clipRect) return inner;
      return intersectRect(inner, layout.clipRect) ?? { x: 0, y: 0, w: 0, h: 0 };
    });

    function clipboardCanWrite(api: { supported: boolean; canWrite?: boolean }): boolean {
      return api.canWrite ?? api.supported;
    }

    async function writeClipboardText(text: string): Promise<void> {
      const contextClipboard = terminalContext.clipboard;

      if (contextClipboard) {
        if (!clipboardCanWrite(contextClipboard)) {
          throw new Error("Clipboard write not available in this runtime");
        }
        await contextClipboard.writeText(text);
        return;
      }

      const navClipboard = (globalThis as any).navigator?.clipboard;
      if (navClipboard && typeof navClipboard.writeText === "function") {
        await navClipboard.writeText(text);
        return;
      }

      throw new Error("Clipboard write not available in this runtime");
    }

    async function copySource(): Promise<void> {
      const text = source.value;
      const requestVersion = ++copyRequestVersion;
      let ok = false;
      let copyError: unknown;

      try {
        await writeClipboardText(text);
        ok = true;
      } catch (err) {
        copyError = err;
      }

      if (!alive) return;
      const isLatestForCurrentSource =
        requestVersion === copyRequestVersion && source.value === text;
      if (isLatestForCurrentSource) {
        if (ok) showCopiedFeedback();
        else setCopied(false);
      }
      emit("copy", ok ? { text, ok } : { text, ok, error: copyError });
    }

    function onCopyClick(event: TerminalPointerEvent): void {
      event.preventDefault();
      event.stopPropagation();
      void copySource();
    }

    function onCopyKeydown(event: TerminalKeyboardEvent): void {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      void copySource();
    }

    const copyNodeActive = computed(
      () => visible.value && props.copyButton && copyHitRect.value.w > 0 && copyHitRect.value.h > 0,
    );

    useTerminalNode(() => ({
      rect: copyHitRect.value,
      zIndex: (parentEventZ.value ?? 0) + props.zIndex + 1,
      visible: copyNodeActive.value,
      focusable: copyNodeActive.value,
      selectable: false,
      handlers: copyNodeActive.value
        ? {
            click: onCopyClick,
            keydown: onCopyKeydown,
          }
        : {},
    }));

    const contentNodeActive = computed(
      () =>
        visible.value &&
        props.copyOnClick &&
        contentHitRect.value.w > 0 &&
        contentHitRect.value.h > 0,
    );

    useTerminalNode(() => ({
      rect: contentHitRect.value,
      zIndex: (parentEventZ.value ?? 0) + props.zIndex,
      visible: contentNodeActive.value,
      focusable: false,
      selectable: false,
      handlers: contentNodeActive.value
        ? {
            click: onCopyClick,
          }
        : {},
    }));

    useRenderNode(() => ({
      zIndex: props.zIndex,
      rect: visible.value ? absRect.value : { x: 0, y: 0, w: 0, h: 0 },
      deps: [
        visible.value,
        absRect.value,
        fullRect.value,
        imageCells.value,
        displayFit.value,
        sourceLines.value,
        currentStyle.value,
        props.clear,
        hasBox.value,
        boxChars.value,
        props.title,
        props.copyButton,
        copyLabel.value,
        graphicsOutputVersion.value,
        documentVersion.value,
      ],
      paint: (dirtyRows) => {
        withTextWidthProvider(widthProvider, () => {
          if (!visible.value) {
            queueClearGraphic();
            return;
          }

          const r = absRect.value;
          const full = fullRect.value;
          if (r.w <= 0 || r.h <= 0) {
            queueClearGraphic();
            return;
          }

          const style = currentStyle.value;
          const dx = Math.max(0, Math.floor(r.x - full.x));
          const fullY = Math.floor(full.y);
          const fullW = Math.max(0, Math.floor(full.w));
          const fullH = Math.max(0, Math.floor(full.h));
          const blank = props.clear ? spaces(r.w) : "";

          const paintRow = (y: number) => {
            if (y < r.y || y >= r.y + r.h) return;

            const rowIndex = y - fullY;
            if (rowIndex < 0 || rowIndex >= fullH) {
              if (props.clear) terminal.write(blank, { x: r.x, y, style });
              return;
            }

            const src = boxRow(rowIndex, fullW, fullH);
            const clipped = dx > 0 ? sliceCellsRange(src, dx, dx + r.w) : sliceCells(src, r.w);
            const value = props.clear ? padCells(clipped, r.w) : clipped;
            if (value || props.clear) {
              terminal.write(value, { x: r.x, y, style });
            }
          };

          if (imageCells.value && displayFit.value) {
            queueImageGraphic(full, displayFit.value);
          } else {
            queueClearGraphic();
          }

          if (dirtyRows?.length) {
            for (const y of dirtyRows) paintRow(y);
            return;
          }

          for (let y = r.y; y < r.y + r.h; y++) paintRow(y);
        });
      },
    }));

    return () => h("span", rootProps);
  },
});

export const TMermaidImageText = TMermaidImage;
