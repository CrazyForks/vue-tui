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
    cellWidthPx: Math.max(1, Math.floor(options?.cellWidthPx ?? DEFAULT_MERMAID_IMAGE_OPTIONS.cellWidthPx)),
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

function mermaidImageCacheKey(
  code: string,
  options: RequiredMermaidImageOptions,
): string {
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
      return candidate as (text: string, options: Record<string, unknown>) => string | Promise<string>;
    }
  }
  return null;
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

          const rendered = (
            new Resvg(svgText, {
              background: "rgba(0,0,0,0)",
            }) as unknown as {
              render: () => { width?: number; height?: number; asPng?: () => Uint8Array };
            }
          ).render();

          const naturalWidth = positiveInt(rendered?.width);
          const naturalHeight = positiveInt(rendered?.height);
          const png =
            typeof rendered?.asPng === "function" ? rendered.asPng() : undefined;
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
