import { resolveMarkdownMathColor } from "../markdown/math-image.js";

export type TuiMermaidImageCells = Readonly<{
  base64: string;
  widthCells: number;
  heightCells: number;
  naturalWidth?: number;
  naturalHeight?: number;
}>;

export type TuiMermaidImageOptions = Readonly<{
  cellWidthPx?: number;
  cellHeightPx?: number;
  scale?: number;
  /** Diagram background color; the raster stays transparent and this is only
   *  used to derive the theme. Pass a CSS color (hex or named). */
  bg?: string;
  /** Diagram foreground color (nodes/edge labels). Resolved from the terminal
   *  style when the caller does not pass one. */
  fg?: string;
  maxWidthCells?: number;
  maxHeightCells?: number;
  /** Canvas padding in px (beautiful-mermaid default). */
  padding?: number;
}>;

export type TuiMermaidImageRasterizer = (
  code: string,
  options: Required<TuiMermaidImageOptions>,
) => Promise<TuiMermaidImageCells | null>;

type RequiredMermaidImageOptions = Required<TuiMermaidImageOptions>;

const DEFAULT_MERMAID_IMAGE_OPTIONS: RequiredMermaidImageOptions = Object.freeze({
  cellWidthPx: 8,
  cellHeightPx: 16,
  scale: 2,
  bg: "#1e1e2e",
  fg: "#f8f8f2",
  maxWidthCells: 0,
  maxHeightCells: 0,
  padding: 40,
});

const MAX_CACHE_ENTRIES = 48;
const MAX_FAILED_ENTRIES = 96;
const mermaidImageCache = new Map<string, TuiMermaidImageCells>();
const mermaidImageFailed = new Set<string>();
const mermaidImageInflight = new Map<string, Promise<TuiMermaidImageCells | null>>();
const mermaidImageListeners = new Set<() => void>();

let customRasterizer: TuiMermaidImageRasterizer | null = null;
let builtinRasterizerLoad: Promise<TuiMermaidImageRasterizer | null> | null = null;
let builtinRasterizerReady = false;

export function normalizeMermaidImageOptions(
  options?: TuiMermaidImageOptions,
): RequiredMermaidImageOptions {
  return {
    cellWidthPx: Math.max(
      1,
      Math.floor(options?.cellWidthPx ?? DEFAULT_MERMAID_IMAGE_OPTIONS.cellWidthPx),
    ),
    cellHeightPx: Math.max(
      1,
      Math.floor(options?.cellHeightPx ?? DEFAULT_MERMAID_IMAGE_OPTIONS.cellHeightPx),
    ),
    scale: Math.max(1, Math.floor(options?.scale ?? DEFAULT_MERMAID_IMAGE_OPTIONS.scale)),
    bg: options?.bg ?? DEFAULT_MERMAID_IMAGE_OPTIONS.bg,
    fg: options?.fg ?? DEFAULT_MERMAID_IMAGE_OPTIONS.fg,
    maxWidthCells: Math.max(0, Math.floor(options?.maxWidthCells ?? 0)),
    maxHeightCells: Math.max(0, Math.floor(options?.maxHeightCells ?? 0)),
    padding: Math.max(0, Math.floor(options?.padding ?? DEFAULT_MERMAID_IMAGE_OPTIONS.padding)),
  };
}

/**
 * Resolve a diagram foreground/background from a terminal style value.
 * Reuses the named-color table shared with the math rasterizer.
 */
export function resolveMermaidImageColor(fg: unknown): string | undefined {
  return resolveMarkdownMathColor(fg);
}

/**
 * Install a custom mermaid -> PNG rasterizer (e.g. consumers that render
 * mermaid through their own pipeline). Passing `null` restores the built-in
 * lazy loader (beautiful-mermaid SVG + @resvg/resvg-js).
 */
export function setMermaidImageRasterizer(rasterizer: TuiMermaidImageRasterizer | null): void {
  customRasterizer = rasterizer;
}

export function subscribeMermaidImage(listener: () => void): () => void {
  mermaidImageListeners.add(listener);
  return () => mermaidImageListeners.delete(listener);
}

/**
 * True when a rasterizer is confirmed available (custom one installed, or the
 * built-in beautiful-mermaid + resvg stack finished loading). Components gate
 * image production on this so they never re-rasterize while the engine is
 * still loading or missing.
 */
export function isMermaidImageRendererReady(): boolean {
  return customRasterizer != null || builtinRasterizerReady;
}

/**
 * Ensure the mermaid rasterizer is loaded (or resolved as unavailable).
 * Resolves `true` once a rasterizer is usable. Safe to call repeatedly; the
 * underlying load is shared and its outcome is cached.
 */
export async function loadMermaidImageRenderer(): Promise<boolean> {
  if (isMermaidImageRendererReady()) return true;
  const rasterizer = customRasterizer ?? (await loadBuiltinMermaidRasterizer());
  builtinRasterizerReady = rasterizer != null;
  return builtinRasterizerReady;
}

function hashMermaidImageKey(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function mermaidImageCacheKey(code: string, options: RequiredMermaidImageOptions): string {
  return hashMermaidImageKey(
    [
      code,
      options.cellWidthPx,
      options.cellHeightPx,
      options.scale,
      options.bg,
      options.fg,
      options.maxWidthCells,
      options.maxHeightCells,
      options.padding,
    ].join("\x1F"),
  );
}

function notifyMermaidImageListeners(): void {
  for (const listener of mermaidImageListeners) {
    try {
      listener();
    } catch {
      // Listener errors must not break the raster pipeline.
    }
  }
}

/** Synchronous cache lookup used by components before deciding to re-render. */
export function getCachedMermaidImage(
  code: string,
  options?: TuiMermaidImageOptions,
): TuiMermaidImageCells | null {
  return (
    mermaidImageCache.get(mermaidImageCacheKey(code, normalizeMermaidImageOptions(options))) ?? null
  );
}

/**
 * Drop all cached mermaid images (PNG + failed lookups). Useful for long
 * running processes that change cell metrics, and for tests.
 */
export function clearMermaidImageCache(): void {
  mermaidImageCache.clear();
  mermaidImageFailed.clear();
}

function evictOldestMermaidImageEntry(): void {
  const oldest = mermaidImageCache.keys().next().value;
  if (oldest != null) mermaidImageCache.delete(oldest);
}

/**
 * Resolve a mermaid diagram to a PNG base64 + cell size. Cached per
 * (code, cell metrics, colors). In-flight requests are deduped. When a new
 * image finishes, `subscribeMermaidImage` listeners are notified so components
 * can rebuild/re-paint with the real size.
 */
export async function getMermaidImage(
  code: string,
  options?: TuiMermaidImageOptions,
): Promise<TuiMermaidImageCells | null> {
  const source = String(code ?? "").trim();
  if (!source) return null;
  const normalized = normalizeMermaidImageOptions(options);
  const key = mermaidImageCacheKey(source, normalized);

  const cached = mermaidImageCache.get(key);
  if (cached) return cached;
  if (mermaidImageFailed.has(key)) return null;

  const inflight = mermaidImageInflight.get(key);
  if (inflight) return inflight;

  const pending = (async () => {
    try {
      const rasterizer = customRasterizer ?? (await loadBuiltinMermaidRasterizer());
      if (!rasterizer) return null;
      const result = await rasterizer(source, normalized);
      if (result && result.base64) {
        mermaidImageCache.set(key, result);
        if (mermaidImageCache.size > MAX_CACHE_ENTRIES) evictOldestMermaidImageEntry();
        notifyMermaidImageListeners();
      } else if (result === null) {
        // The engine was available but could not render this diagram; remember
        // the failure so rebuilds do not re-rasterize it over and over.
        mermaidImageFailed.add(key);
        if (mermaidImageFailed.size > MAX_FAILED_ENTRIES) {
          const oldest = mermaidImageFailed.values().next().value;
          if (oldest != null) mermaidImageFailed.delete(oldest);
        }
      }
      return result;
    } catch {
      return null;
    } finally {
      mermaidImageInflight.delete(key);
    }
  })();
  mermaidImageInflight.set(key, pending);
  return pending;
}

function base64FromBytes(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
}

function positiveInt(value: unknown): number | undefined {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function clampCellsToLimits(
  widthCells: number,
  heightCells: number,
  maxWidthCells: number,
  maxHeightCells: number,
): Readonly<{ widthCells: number; heightCells: number }> {
  let w = widthCells;
  let h = heightCells;
  if (maxWidthCells > 0 && w > maxWidthCells) {
    h = Math.max(1, Math.round((h * maxWidthCells) / w));
    w = maxWidthCells;
  }
  if (maxHeightCells > 0 && h > maxHeightCells) {
    w = Math.max(1, Math.round((w * maxHeightCells) / h));
    h = maxHeightCells;
  }
  return { widthCells: Math.max(1, w), heightCells: Math.max(1, h) };
}

/**
 * @resvg/resvg-js is a Node-only native addon. Keeping the specifier in a
 * variable (a non-literal dynamic import) stops browser bundlers
 * (vite/rolldown) from statically resolving it and failing on its platform
 * `.node` binding; at runtime a browser load fails and the rasterizer falls
 * back to raw source.
 */
const RESVG_MODULE_ID = "@resvg/resvg-js";

type BeautifulMermaidModule = Readonly<{
  renderMermaidSVGAsync?: unknown;
  renderMermaidSVG?: unknown;
  renderMermaid?: unknown;
  default?: unknown;
}>;

function svgRenderFunction(
  mod: BeautifulMermaidModule,
): ((text: string, options: Record<string, unknown>) => string | Promise<string>) | null {
  const candidates: unknown[] = [
    mod.renderMermaidSVGAsync,
    mod.renderMermaidSVG,
    mod.renderMermaid,
    (mod.default as BeautifulMermaidModule | undefined)?.renderMermaidSVGAsync,
    (mod.default as BeautifulMermaidModule | undefined)?.renderMermaidSVG,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "function") {
      return candidate as (
        text: string,
        options: Record<string, unknown>,
      ) => string | Promise<string>;
    }
  }
  return null;
}

/**
 * @resvg/resvg-js (usvg) does not support CSS custom properties (`var()`) or
 * `color-mix()`. beautiful-mermaid 1.x emits both, so feeding the raw SVG to
 * resvg renders every shape black. This resolver inlines all `var(--x)` /
 * `color-mix(in srgb, ...)` color expressions into concrete hex values before
 * rasterization. Exported for tests.
 */
export function resolveMermaidSvgForResvg(
  svg: string,
  fallbackBg: string,
  fallbackFg: string,
): string {
  const { bg, fg } = extractSvgRootStyleColors(svg, fallbackBg, fallbackFg);
  const variables = extractSvgCssVariables(svg);
  const root = { bg, fg };
  let resolved = svg;

  let guard = 0;
  while ((resolved.includes("var(") || resolved.includes("color-mix(")) && guard++ < 500) {
    const varIndex = resolved.lastIndexOf("var(");
    const mixIndex = resolved.lastIndexOf("color-mix(");
    const at = Math.max(varIndex, mixIndex);
    if (at < 0) break;

    const open = resolved.indexOf("(", at);
    const close = findMatchingSvgParen(resolved, open);
    if (open < 0 || close < 0) break;

    const expr = resolved.slice(at, close + 1);
    const color = resolveSvgColorExpr(expr, root, variables);
    resolved = resolved.slice(0, at) + color + resolved.slice(close + 1);
  }

  return stripSvgStyleBlocks(resolved);
}

function extractSvgRootStyleColors(
  svg: string,
  fallbackBg: string,
  fallbackFg: string,
): { bg: string; fg: string } {
  let bg = fallbackBg;
  let fg = fallbackFg;
  const styleMatch = /<svg\b[^>]*\bstyle="([^"]*)"/i.exec(svg);
  if (styleMatch?.[1]) {
    const bgMatch = /(?:^|;)\s*--bg\s*:\s*([^;]+)/i.exec(styleMatch[1]);
    const fgMatch = /(?:^|;)\s*--fg\s*:\s*([^;]+)/i.exec(styleMatch[1]);
    if (bgMatch?.[1]) bg = bgMatch[1].trim();
    if (fgMatch?.[1]) fg = fgMatch[1].trim();
  }
  return { bg, fg };
}

function extractSvgCssVariables(svg: string): Map<string, string> {
  const map = new Map<string, string>();
  const styleMatch = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(svg);
  if (!styleMatch?.[1]) return map;
  const declaration = /(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+);/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(styleMatch[1])) !== null) {
    map.set(match[1], match[2].trim());
  }
  return map;
}

function stripSvgStyleBlocks(svg: string): string {
  return svg.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
}

function findMatchingSvgParen(input: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findTopLevelSvgComma(input: string): number {
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) return i;
  }
  return -1;
}

function normalizeHexColor(value: string): string | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((ch) => ch + ch)
      .join("");
  }
  return `#${hex.toLowerCase()}`;
}

function mixSrgbColors(aHex: string, bHex: string, percent: number): string {
  const a = parseHexRgb(aHex);
  const b = parseHexRgb(bHex);
  const p = Math.max(0, Math.min(100, percent)) / 100;
  const mix = (x: number, y: number) => Math.round(x * p + y * (1 - p));
  const toHex = (value: number) => value.toString(16).padStart(2, "0");
  return `#${toHex(mix(a[0], b[0]))}${toHex(mix(a[1], b[1]))}${toHex(mix(a[2], b[2]))}`;
}

function parseHexRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function resolveSvgColorExpr(
  expr: string,
  root: Readonly<{ bg: string; fg: string }>,
  variables: Map<string, string>,
): string {
  const value = expr.trim();

  if (value.startsWith("var(")) {
    const close = findMatchingSvgParen(value, 3);
    if (close < 0) return value;
    const inner = value.slice(4, close).trim();
    const comma = findTopLevelSvgComma(inner);
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? "" : inner.slice(comma + 1).trim();

    const direct = name === "--fg" ? root.fg : name === "--bg" ? root.bg : variables.get(name);
    if (direct != null) return resolveSvgColorExpr(direct, root, variables);
    if (fallback) return resolveSvgColorExpr(fallback, root, variables);
    return value;
  }

  if (value.startsWith("color-mix(")) {
    const close = findMatchingSvgParen(value, 9);
    if (close < 0) return value;
    const inner = value.slice(10, close).trim();
    const afterMethod = inner.replace(/^in\s+srgb\s*,\s*/i, "");
    const comma = findTopLevelSvgComma(afterMethod);
    if (comma < 0) return value;

    const left = afterMethod.slice(0, comma).trim();
    const right = afterMethod.slice(comma + 1).trim();
    const leftMatch = /^([^%\s]+)\s+([\d.]+)%$/.exec(left) ?? /^([\d.]+)%\s+([^%\s]+)$/.exec(left);
    if (!leftMatch) return value;

    const a = normalizeHexColor(resolveSvgColorExpr(leftMatch[1], root, variables));
    const b = normalizeHexColor(resolveSvgColorExpr(right, root, variables));
    if (!a || !b) return value;
    return mixSrgbColors(a, b, Number(leftMatch[2]));
  }

  return normalizeHexColor(value) ?? value;
}

function loadBuiltinMermaidRasterizer(): Promise<TuiMermaidImageRasterizer | null> {
  if (!builtinRasterizerLoad) {
    builtinRasterizerLoad = (async () => {
      try {
        const [mermaidMod, resvgMod] = await Promise.all([
          import("beautiful-mermaid").then(
            (mod) => mod as BeautifulMermaidModule,
            () => null,
          ),
          import(RESVG_MODULE_ID).then(
            (mod) => mod as { Resvg?: new (svg: string, options?: unknown) => unknown },
            () => null,
          ),
        ]);
        const renderSvg = svgRenderFunction(mermaidMod ?? {});
        const Resvg = resvgMod?.Resvg;
        if (!renderSvg || typeof Resvg !== "function") return null;

        return async (code, options) => {
          const svg = await renderSvg(code, {
            bg: options.bg,
            fg: options.fg,
            padding: options.padding,
            transparent: true,
          });
          const svgText = String(svg ?? "");
          if (!svgText.includes("<svg")) return null;

          // resvg cannot resolve CSS var()/color-mix(); inline concrete colors
          // first so the diagram is not rasterized as pure black.
          const resolvedSvg = resolveMermaidSvgForResvg(svgText, options.bg, options.fg);

          const rendered = (
            new Resvg(resolvedSvg, {
              background: "rgba(0,0,0,0)",
            }) as unknown as {
              render: () => { width?: number; height?: number; asPng?: () => Uint8Array };
            }
          ).render();

          const naturalWidth = positiveInt(rendered?.width);
          const naturalHeight = positiveInt(rendered?.height);
          const png = typeof rendered?.asPng === "function" ? rendered.asPng() : undefined;
          if (!png || png.length < 8 || naturalWidth == null || naturalHeight == null) {
            return null;
          }

          const rawWidthCells = Math.max(
            1,
            Math.round(naturalWidth / (options.cellWidthPx * options.scale)),
          );
          const rawHeightCells = Math.max(
            1,
            Math.round(naturalHeight / (options.cellHeightPx * options.scale)),
          );
          const { widthCells, heightCells } = clampCellsToLimits(
            rawWidthCells,
            rawHeightCells,
            options.maxWidthCells,
            options.maxHeightCells,
          );

          return {
            base64: base64FromBytes(png),
            widthCells,
            heightCells,
            naturalWidth,
            naturalHeight,
          };
        };
      } catch {
        return null;
      }
    })();
  }
  return builtinRasterizerLoad;
}
