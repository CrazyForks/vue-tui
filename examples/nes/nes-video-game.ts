/**
 * Terminal NES emulator — vue-tui game component.
 *
 * Drives a jsnes (Apache-2.0) instance synchronously and pushes every NES frame
 * (256×240) into the TVideo terminal-graphics pipeline as a PNG, exactly like
 * the contra/flappy examples. Frames are nearest-neighbour resampled onto the
 * placement box so the terminal never crops the picture.
 *
 * Input mapping (terminal key → NES controller):
 *   ←↑↓→ / WASD   → D-pad
 *   Z / J          → B (shoot)
 *   X / K          → A (jump)
 *   Enter          → Start
 *   Shift          → Select
 *   P              → pause emulation
 *   Q / Ctrl+C     → quit
 */
import { defineComponent, h, onBeforeUnmount, onMounted, ref } from "vue";
import { TVideo, type TVideoFrameSourceContext } from "../../src/experimental.js";
import { TBox, TText, useTerminal } from "../../src/vue.js";
import Controller from "./vendor/jsnes/src/controller.js";
import Nes from "./vendor/jsnes/src/nes.js";
import { encodeRgbaPng, resizeNearest } from "./png.js";

export const NES_W = 256;
export const NES_H = 240;
export const TARGET_FPS = 60;

export type NesVideoCreateOptions = {
  rom: Uint8Array;
  cols?: number;
  rows?: number;
};

/**
 * Fit the 256×240 NES picture into the bordered box without distortion.
 *
 * Terminal cells are roughly twice as tall as they are wide (6×12 px in the
 * kitty pipeline), so a "square" image needs about twice as many columns as
 * rows. The video area fills the available space while preserving the pixel
 * aspect ratio on screen; the frame PNG is produced at the same aspect so the
 * terminal renders it without cropping or squeezing.
 */
const CELL_W_PX = 6;
const CELL_H_PX = 12;
/** Visible NES picture: jsnes renders 256×240, but rows 8-15 and 232-239 are
 *  NTSC overscan (black bars) — crop them for a juicier, taller picture. */
export const NES_VISIBLE_W = 256;
export const NES_VISIBLE_H = 224;

export function getNesVideoLayout(cols: number, rows: number) {
  const boxW = Math.max(48, Math.floor(cols));
  const boxH = Math.max(16, Math.floor(rows));
  const contentW = Math.max(40, boxW - 4);
  const contentH = Math.max(10, boxH - 4);
  // The video area fills everything between a small top gap and the help
  // line:
  //   row 0: top gap (1 row, keeps the video off the border)
  //   rows 1..helpY-1: video area
  //   row helpY: help text
  const topGap = 1;
  const helpRow = 1;
  const availableH = Math.max(4, contentH - topGap - helpRow);
  const availableW = contentW;
  // Preferred rendering: integer multiples of the visible NES picture
  // (256×224 after overscan crop). Nearest-neighbour at integer scales is
  // pixel-perfect — no blur, no moiré. Pick the largest whole scale that fits
  // the video box (each cell ≈6px wide ×12px tall).
  let scale = Math.max(
    1,
    Math.min(
      Math.floor((availableW * CELL_W_PX) / NES_VISIBLE_W),
      Math.floor((availableH * CELL_H_PX) / NES_VISIBLE_H),
    ),
  );
  let frameW = NES_VISIBLE_W * scale;
  let frameH = NES_VISIBLE_H * scale;
  // If even 1× doesn't fit (very small terminals), fall back to the exact-fit
  // fractional path that fills the box — still correct, just slightly softer.
  if (frameH > availableH * CELL_H_PX || frameW > availableW * CELL_W_PX) {
    scale = 1;
    frameH = Math.min(availableH * CELL_H_PX, NES_VISIBLE_H);
    frameW = Math.round(frameH * (NES_VISIBLE_W / NES_VISIBLE_H));
    if (frameW > availableW * CELL_W_PX) {
      frameW = availableW * CELL_W_PX;
      frameH = Math.round(frameW / (NES_VISIBLE_W / NES_VISIBLE_H));
    }
  }
  // Placement box in cells: the same frame displayed cell-by-cell.
  const videoW = Math.max(8, Math.round(frameW / CELL_W_PX));
  const videoH = Math.max(4, Math.round(frameH / CELL_H_PX));
  // Center horizontally and vertically within the video area (so the bottom
  // never overlaps the help line).
  const videoX = Math.max(0, Math.floor((contentW - videoW) / 2));
  const videoY = topGap + Math.max(0, Math.floor((availableH - videoH) / 2));
  const helpY = contentH - 1;
  return {
    boxW,
    boxH,
    contentW,
    contentH,
    videoX,
    videoY,
    videoW,
    videoH,
    helpY,
    frameW,
    frameH,
    scale,
  };
}

/** Convert jsnes' Uint32 (0xRRGGBB) frame buffer to RGBA bytes. */
function ppuToRgba(pixels: Uint32Array, out: Uint8Array): void {
  for (let i = 0; i < pixels.length; i++) {
    const v = pixels[i]!;
    const j = i * 4;
    out[j] = (v >> 16) & 255;
    out[j + 1] = (v >> 8) & 255;
    out[j + 2] = v & 255;
    out[j + 3] = 255;
  }
}

/** Copy the visible 256×224 picture (overscan 8px top/bottom cropped) out of
 *  the PPU's 256×240 buffer into `out` (must be 256*224*4 bytes). */
function cropToVisible(pixels: Uint32Array, out: Uint8Array): void {
  const rowBytes = NES_VISIBLE_W * 4;
  const top = 8;
  for (let y = 0; y < NES_VISIBLE_H; y++) {
    const src = (y + top) * NES_W;
    for (let x = 0; x < NES_VISIBLE_W; x++) {
      const v = pixels[src + x]!;
      const j = y * rowBytes + x * 4;
      out[j] = (v >> 16) & 255;
      out[j + 1] = (v >> 8) & 255;
      out[j + 2] = v & 255;
      out[j + 3] = 255;
    }
  }
}

export type NesButton =
  | "up"
  | "down"
  | "left"
  | "right"
  | "a"
  | "b"
  | "select"
  | "start";

const NES_BUTTON: Record<NesButton, number> = {
  up: Controller.BUTTON_UP,
  down: Controller.BUTTON_DOWN,
  left: Controller.BUTTON_LEFT,
  right: Controller.BUTTON_RIGHT,
  a: Controller.BUTTON_A,
  b: Controller.BUTTON_B,
  select: Controller.BUTTON_SELECT,
  start: Controller.BUTTON_START,
};

export function createNesVideoGame(options: NesVideoCreateOptions) {
  const layout = ref(getNesVideoLayout(options.cols ?? 100, options.rows ?? 30));
  const paused = ref(false);
  const held = new Set<NesButton>();
  const nes = new Nes({ emulateSound: false });
  nes.loadROM(options.rom);

  /** Read-only NES ROM header info (mapper + bank counts) for the runner. */
  const getRomInfo = (): {
    mapper: number;
    mapperSupported: boolean;
    prgPages: number;
    chrPages: number;
    mirroring: "horizontal" | "vertical";
  } => {
    const rom = (nes as unknown as { rom?: { mapperType?: number; romCount?: number; vromCount?: number; mirroring?: number } }).rom;
    return {
      mapper: rom?.mapperType ?? -1,
      mapperSupported: rom?.mapperType != null,
      prgPages: rom?.romCount ?? 0,
      chrPages: rom?.vromCount ?? 0,
      mirroring: rom?.mirroring ? "vertical" : "horizontal",
    };
  };

  const setControl = (key: NesButton, down: boolean): void => {
    if (down) {
      if (held.has(key)) return;
      held.add(key);
      nes.buttonDown(1, NES_BUTTON[key]!);
    } else if (held.delete(key)) {
      nes.buttonUp(1, NES_BUTTON[key]!);
    }
  };

  const releaseAll = (): void => {
    for (const key of held) nes.buttonUp(1, NES_BUTTON[key]!);
    held.clear();
  };

  const rgba = new Uint8Array(NES_W * NES_H * 4);
  const visible = new Uint8Array(NES_VISIBLE_W * NES_VISIBLE_H * 4);

  const frameSource = async function* (context: TVideoFrameSourceContext) {
    let frameW = 0;
    let frameH = 0;
    let buf: Uint8Array | null = null;
    let lastNow = 0;
    while (!context.signal.aborted) {
      const now = performance.now();
      const dt = lastNow === 0 ? 1000 / TARGET_FPS : Math.min(50, now - lastNow);
      lastNow = now;
      const l = layout.value;
      if (l.frameW !== frameW || l.frameH !== frameH) {
        frameW = l.frameW;
        frameH = l.frameH;
        buf = new Uint8Array(frameW * frameH * 4);
      }
      if (!paused.value) nes.frame();
      // Crop the NTSC overscan (8 rows top + 8 rows bottom) and present the
      // true 256×224 picture; the layout already chose an integer upscale so
      // the nearest-neighbour pass below is pixel-perfect.
      cropToVisible(nes.ppu.buffer, visible);
      resizeNearest(visible, NES_VISIBLE_W, NES_VISIBLE_H, buf!, frameW, frameH);
      const png = encodeRgbaPng(buf!, frameW, frameH);
      yield { png, pixelWidth: frameW, pixelHeight: frameH, timestampMs: now };
      const elapsed = performance.now() - now;
      const delay = Math.max(0, 1000 / TARGET_FPS - elapsed);
      if (delay > 0) await new Promise((ok) => setTimeout(ok, delay));
    }
  };

  const component = defineComponent({
    name: "NesVideoGame",
    setup() {
      const { terminal, scheduler } = useTerminal();
      const offResize = terminal.on("resize", () => {
        layout.value = getNesVideoLayout(terminal.size().cols - 2, terminal.size().rows - 2);
        scheduler.invalidate();
      });
      onMounted(() => {
        layout.value = getNesVideoLayout(terminal.size().cols - 2, terminal.size().rows - 2);
        scheduler.invalidate();
      });
      onBeforeUnmount(() => {
        offResize();
        releaseAll();
      });

      const title = () => (paused.value ? " NES · PAUSED " : " NES · PLAYING ");

      return () => {
        const l = layout.value;
        return h(
          TBox,
          {
            x: 0,
            y: 0,
            w: l.boxW,
            h: l.boxH,
            border: true,
            padding: 1,
            title: title(),
            style: { fg: "greenBright", bg: "black" },
            titleStyle: { fg: "green", bold: true },
          },
          () => [
            h(TVideo, {
              x: l.videoX,
              y: l.videoY,
              w: l.videoW,
              h: l.videoH,
              src: "nes://frame",
              frameSource,
              pixelWidth: l.frameW,
              pixelHeight: l.frameH,
              maxFps: TARGET_FPS,
              fallback: "[NES — this terminal lacks a graphics protocol]",
              style: { bg: "black" },
            }),
            h(TText, {
              x: 0,
              y: l.helpY,
              w: l.contentW,
              value:
                "←↑↓→ / WASD 移动 · Z/J=B 射击 · X/K=A 跳跃 · Enter=Start · S=分享到X · P=暂停 · Q/Ctrl+C=退出",
              style: { fg: "white", dim: true },
            }),
          ],
        );
      };
    },
  });

  return {
    component,
    nes,
    setControl,
    releaseAll,
    getRomInfo,
    pause: () => void (paused.value = !paused.value),
    setPaused: (v: boolean) => void (paused.value = v),
    isPaused: () => paused.value,
    /**
     * Snapshot the latest PPU frame (visible 256×224 overscan-cropped) as RGBA
     * for the share-to-X screenshot.
     */
    frameSnapshot: () => {
      const out = new Uint8Array(NES_VISIBLE_W * NES_VISIBLE_H * 4);
      cropToVisible(nes.ppu.buffer, out);
      return out;
    },
  };
}