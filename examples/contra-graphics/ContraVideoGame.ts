/**
 * Terminal Contra (魂斗罗) — kitty-graphics game component.
 *
 * Pixels, not characters: the simulation (../contra/engine.ts) runs on a
 * 30fps tick and a frame-source generator rasterizes each snapshot onto an
 * RGBA canvas (scene.ts), encodes it as PNG (art.ts) and feeds it to TVideo,
 * which pushes the frames through the terminal graphics queue (kitty / iTerm2
 * / sixel — the same pipeline as terminal-flappy-bird).
 *
 * Important: the pixel-art scene is currently authored on a fixed 432×288
 * source canvas (72×24 cells). On larger terminals we must cap the live game
 * viewport to that authored area; otherwise the engine places the ground below
 * the source canvas and the player only peeks into view while jumping.
 */
import type { TVideoFrameSourceContext } from "../../src/experimental.js";
import { defineComponent, h, onBeforeUnmount, onMounted, ref } from "vue";
import { TVideo } from "../../src/experimental.js";
import { TBox, TText, useTerminal } from "../../src/vue.js";
import { ContraEngine, type ContraGameOptions } from "../contra/engine.js";
import { CELL_H_PX, CELL_W_PX, encodeRgbaPng } from "./art.js";
import { CANVAS_H, CANVAS_W, renderScene } from "./scene.js";

export const TARGET_FPS = 30;
export const FRAME_MS = 1000 / TARGET_FPS;
export const GAME_SRC = "contra://game";
const MAX_GAME_COLS = Math.floor(CANVAS_W / CELL_W_PX);
const MAX_GAME_ROWS = Math.floor(CANVAS_H / CELL_H_PX);

export type ContraVideoCreateOptions = ContraGameOptions & {
  /** Terminal cols/rows for the bordered box (playfield = these minus chrome). */
  cols?: number;
  rows?: number;
};

export type ContraVideoLayout = {
  boxW: number;
  boxH: number;
  contentW: number;
  contentH: number;
  videoX: number;
  videoY: number;
  videoW: number;
  videoH: number;
  helpY: number;
  frameW: number;
  frameH: number;
};

export function getContraVideoLayout(cols: number, rows: number): ContraVideoLayout {
  const boxW = Math.max(44, Math.floor(cols));
  const boxH = Math.max(16, Math.floor(rows));
  const contentW = Math.max(40, boxW - 4);
  const contentH = Math.max(10, boxH - 4);
  const statusH = 1;
  const topGap = 1;
  const helpH = 1;
  const availableVideoH = Math.max(6, contentH - statusH - topGap - helpH);
  const videoW = Math.min(contentW, MAX_GAME_COLS);
  const videoH = Math.min(availableVideoH, MAX_GAME_ROWS);
  const videoX = Math.max(0, Math.floor((contentW - videoW) / 2));
  const videoY = statusH + topGap + Math.max(0, Math.floor((availableVideoH - videoH) / 2));
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
    frameW: videoW * CELL_W_PX,
    frameH: videoH * CELL_H_PX,
  };
}

export function createContraVideoGame(options: ContraVideoCreateOptions) {
  const initialLayout = getContraVideoLayout(options.cols ?? 78, options.rows ?? 24);
  const layout = ref(initialLayout);
  const engine = new ContraEngine({
    ...options,
    cols: initialLayout.videoW,
    rows: initialLayout.videoH,
  });

  const applyLayout = (cols: number, rows: number) => {
    const next = getContraVideoLayout(cols, rows);
    const prev = layout.value;
    layout.value = next;
    if (next.videoW !== prev.videoW || next.videoH !== prev.videoH) {
      engine.resize(next.videoW, next.videoH);
    }
  };

  const scoreRef = ref(0);
  const hiScoreRef = ref(0);
  const livesRef = ref(3);
  const stageRef = ref(1);
  const fpsRef = ref(0);

  const frameSource = async function* (context: TVideoFrameSourceContext) {
    let frameW = layout.value.frameW;
    let frameH = layout.value.frameH;
    let buf = new Uint8Array(frameW * frameH * 4);
    let lastTime = 0;
    let frameCount = 0;
    let fpsTime = 0;
    let groundScroll = 0;
    let frameErrorShown = false;
    while (!context.signal.aborted) {
      const now = performance.now();
      const dtMs = lastTime === 0 ? FRAME_MS : Math.min(50, now - lastTime);
      lastTime = now;
      try {
        const nextLayout = layout.value;
        if (nextLayout.frameW !== frameW || nextLayout.frameH !== frameH) {
          frameW = nextLayout.frameW;
          frameH = nextLayout.frameH;
          buf = new Uint8Array(frameW * frameH * 4);
        }

        engine.step(dtMs);

        const s = engine.snapshot();
        scoreRef.value = s.score;
        hiScoreRef.value = s.hiScore;
        livesRef.value = s.lives;
        stageRef.value = s.stage;
        groundScroll += dtMs * 0.03;
        renderScene(buf, s, groundScroll, frameW, frameH);
        const png = encodeRgbaPng(buf, frameW, frameH);
        frameCount += 1;
        if (now - fpsTime >= 1000) {
          fpsRef.value = Math.round((frameCount * 1000) / (now - fpsTime));
          frameCount = 0;
          fpsTime = now;
        }
        yield { png, pixelWidth: frameW, pixelHeight: frameH, timestampMs: now };
      } catch (error) {
        // A single bad frame must never kill the stream (TVideo stops the
        // playback on a thrown frame-source error and the game freezes on a
        // stale image). Log once and keep rendering.
        if (!frameErrorShown) {
          frameErrorShown = true;
          process.stderr.write(
            `[contra] frame error: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
      const elapsed = performance.now() - now;
      const delay = Math.max(0, FRAME_MS - elapsed);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  };

  const component = defineComponent({
    name: "ContraVideoGame",
    setup() {
      const { terminal, scheduler } = useTerminal();
      const syncToTerminal = () => {
        const size = terminal.size();
        applyLayout(Math.max(44, size.cols - 2), Math.max(16, size.rows - 2));
        scheduler.invalidate();
      };
      const offResize = terminal.on("resize", syncToTerminal);

      onMounted(syncToTerminal);
      onBeforeUnmount(offResize);

      const status = () => {
        const phase = engine.getPhase();
        if (phase === "gameover") {
          return `GAME OVER · SCORE ${scoreRef.value} · HI ${hiScoreRef.value}`;
        }
        if (phase === "paused") return "PAUSED — PRESS P TO RESUME";
        return `SCORE ${scoreRef.value}   HI ${hiScoreRef.value}   LIVES ${livesRef.value}   STAGE ${stageRef.value}   ${fpsRef.value} FPS`;
      };

      return () => {
        const current = layout.value;
        return h(
          TBox,
          {
            x: 0,
            y: 0,
            w: current.boxW,
            h: current.boxH,
            border: true,
            padding: 1,
            title: " CONTRA · 魂斗罗 ",
            style: { fg: "greenBright", bg: "black" },
            titleStyle: { fg: "green", bold: true },
          },
          () => [
            h(TText, {
              x: 0,
              y: 0,
              w: current.contentW,
              value: status(),
              style: { fg: "greenBright", bold: true },
            }),
            h(TVideo, {
              x: current.videoX,
              y: current.videoY,
              w: current.videoW,
              h: current.videoH,
              src: GAME_SRC,
              frameSource,
              pixelWidth: current.frameW,
              pixelHeight: current.frameH,
              maxFps: TARGET_FPS,
              fallback: "[CONTRA — this terminal lacks a graphics protocol]",
              style: { bg: "black" },
            }),
            h(TText, {
              x: 0,
              y: current.helpY,
              w: current.contentW,
              value:
                "←→ / AD 移动 · ↑ / W / Space 跳跃 · J / Z 射击 · P 暂停 · Enter 重开 · Q / Ctrl+C 退出",
              style: { fg: "white", dim: true },
            }),
          ],
        );
      };
    },
  });

  return { component, engine, applyLayout };
}
