// Terminal NES emulator — vue-tui game component.
import { defineComponent, h, onBeforeUnmount, onMounted, ref } from "vue";
import { TVideo, type TVideoFrameSourceContext } from "../../src/experimental.js";
import { TBox, TText, TView, useTerminal } from "../../src/vue.js";
import Controller, { type ButtonKey } from "./vendor/jsnes/src/controller.js";
import Nes from "./vendor/jsnes/src/nes.js";
import { encodeRgbaPng, resizeNearest } from "./png.js";

export const NES_W = 256;
export const NES_H = 240;
export const TARGET_FPS = 60;
export const NES_VISIBLE_W = 256;
export const NES_VISIBLE_H = 224;

const CELL_W_PX = 6;
const CELL_H_PX = 12;

export type NesGameProfile = "falling" | "generic";

export type NesGameAnalysis = Readonly<{
  mode: "Day" | "Sunset" | "Night";
  score: number;
  survivalSeconds: number;
  moveInputs: number;
  directionChanges: number;
  summary: string;
}>;

export type NesVideoCreateOptions = {
  rom: Uint8Array;
  cols?: number;
  rows?: number;
  profile?: NesGameProfile;
};

/**
 * Fill the bordered box in terminal cells. The graphics protocol scales the
 * generated PNG to this exact placement, so wide terminals intentionally use
 * all available space instead of leaving large black gutters around the NES
 * aspect ratio.
 */
export function getNesVideoLayout(cols: number, rows: number) {
  const boxW = Math.max(48, Math.floor(cols));
  const boxH = Math.max(16, Math.floor(rows));
  const contentW = Math.max(40, boxW - 4);
  const contentH = Math.max(10, boxH - 4);
  const helpY = contentH - 1;
  const videoW = contentW;
  const videoH = Math.max(4, helpY);
  const frameW = Math.max(1, videoW * CELL_W_PX);
  const frameH = Math.max(1, videoH * CELL_H_PX);

  return {
    boxW,
    boxH,
    contentW,
    contentH,
    videoX: 0,
    videoY: 0,
    videoW,
    videoH,
    helpY,
    frameW,
    frameH,
    scale: Math.min(frameW / NES_VISIBLE_W, frameH / NES_VISIBLE_H),
  };
}

/** Copy the visible 256×224 picture out of jsnes' 256×240 PPU buffer. */
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

export type NesButton = "up" | "down" | "left" | "right" | "a" | "b" | "select" | "start";

const NES_BUTTON: Record<NesButton, ButtonKey> = {
  up: Controller.BUTTON_UP,
  down: Controller.BUTTON_DOWN,
  left: Controller.BUTTON_LEFT,
  right: Controller.BUTTON_RIGHT,
  a: Controller.BUTTON_A,
  b: Controller.BUTTON_B,
  select: Controller.BUTTON_SELECT,
  start: Controller.BUTTON_START,
};

const FALLING_RAM = {
  gameState: 0x00,
  gameMode: 0x0b,
  playerScoreMsb: 0x1b,
  playerScoreLsb: 0x1c,
} as const;

const FALLING_STATE_TITLE = 0;
const FALLING_STATE_PLAYING = 1;
const FALLING_STATE_GAME_OVER = 3;
const MODE_NAMES = ["Day", "Sunset", "Night"] as const;

type NesCpuMemory = { cpu: { mem: Uint8Array } };

function analysisSummary(score: number, survivalSeconds: number, directionChanges: number): string {
  if (score >= 500 || survivalSeconds >= 90) return "节奏稳定，长局表现很强。";
  if (directionChanges >= 12) return "变向较频繁，提前观察落点会更稳。";
  if (survivalSeconds < 15) return "开局先留在中路，给自己更多反应空间。";
  return "路线控制不错，继续减少无效变向。";
}

export function createNesVideoGame(options: NesVideoCreateOptions) {
  const profile = options.profile ?? "generic";
  const layout = ref(getNesVideoLayout(options.cols ?? 100, options.rows ?? 30));
  const paused = ref(false);
  const phase = ref<"title" | "playing" | "gameover">(profile === "falling" ? "title" : "playing");
  const analysis = ref<NesGameAnalysis | null>(null);
  const held = new Set<NesButton>();
  const pulseQueue: NesButton[] = [];
  let activePulse: NesButton | null = null;
  let restartHandler: (() => void) | null = null;
  let playFrames = 0;
  let moveInputs = 0;
  let directionChanges = 0;
  let lastMoveDirection: "left" | "right" | null = null;
  let previousFallingState = FALLING_STATE_TITLE;

  const nes = new Nes({ emulateSound: false });
  nes.loadROM(options.rom);

  const cpuMemory = (): Uint8Array => (nes as unknown as NesCpuMemory).cpu.mem;

  const getRomInfo = (): {
    mapper: number;
    mapperSupported: boolean;
    prgPages: number;
    chrPages: number;
    mirroring: "horizontal" | "vertical";
  } => {
    const rom = (
      nes as unknown as {
        rom?: {
          mapperType?: number;
          romCount?: number;
          vromCount?: number;
          mirroring?: number;
        };
      }
    ).rom;
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
      if (
        profile === "falling" &&
        phase.value === "playing" &&
        (key === "left" || key === "right")
      ) {
        moveInputs++;
        if (lastMoveDirection != null && lastMoveDirection !== key) directionChanges++;
        lastMoveDirection = key;
      }
    } else if (held.delete(key)) {
      nes.buttonUp(1, NES_BUTTON[key]!);
    }
  };

  const clearPulseInput = (): void => {
    pulseQueue.length = 0;
    if (activePulse != null) setControl(activePulse, false);
    activePulse = null;
  };

  const releaseAll = (): void => {
    clearPulseInput();
    for (const key of held) setControl(key, false);
  };

  /**
   * Queue one discrete controller edge. The frame step below always inserts a
   * neutral frame between queued presses, which lets ROM-side button latches
   * observe Down, Down and Down, Up even when terminal events arrive together.
   */
  const queueControlPulse = (key: NesButton): void => {
    pulseQueue.push(key);
  };

  const advancePulseInput = (): void => {
    if (activePulse != null) {
      setControl(activePulse, false);
      activePulse = null;
      return;
    }
    const next = pulseQueue.shift();
    if (next == null) return;
    setControl(next, true);
    activePulse = next;
  };

  const syncFallingState = (): void => {
    if (profile !== "falling") return;
    const memory = cpuMemory();
    const state = memory[FALLING_RAM.gameState]!;

    if (state === FALLING_STATE_PLAYING) {
      if (previousFallingState !== FALLING_STATE_PLAYING) {
        playFrames = 0;
        moveInputs = 0;
        directionChanges = 0;
        lastMoveDirection = null;
        analysis.value = null;
      }
      playFrames++;
      phase.value = "playing";
    } else if (state === FALLING_STATE_GAME_OVER) {
      phase.value = "gameover";
      if (previousFallingState !== FALLING_STATE_GAME_OVER) {
        const mode = MODE_NAMES[Math.min(2, memory[FALLING_RAM.gameMode] ?? 0)]!;
        const score =
          ((memory[FALLING_RAM.playerScoreMsb] ?? 0) << 8) |
          (memory[FALLING_RAM.playerScoreLsb] ?? 0);
        const survivalSeconds = playFrames / TARGET_FPS;
        analysis.value = {
          mode,
          score,
          survivalSeconds,
          moveInputs,
          directionChanges,
          summary: analysisSummary(score, survivalSeconds, directionChanges),
        };
      }
    } else if (state === FALLING_STATE_TITLE) {
      phase.value = "title";
    }

    previousFallingState = state;
  };

  /** Advance exactly one emulated frame, including queued terminal input. */
  const stepFrame = (): void => {
    advancePulseInput();
    nes.frame();
    syncFallingState();
  };

  const reset = (): void => {
    releaseAll();
    nes.reloadROM();
    paused.value = false;
    phase.value = profile === "falling" ? "title" : "playing";
    analysis.value = null;
    playFrames = 0;
    moveInputs = 0;
    directionChanges = 0;
    lastMoveDirection = null;
    previousFallingState = FALLING_STATE_TITLE;
  };

  const visible = new Uint8Array(NES_VISIBLE_W * NES_VISIBLE_H * 4);

  const frameSource = async function* (context: TVideoFrameSourceContext) {
    let frameW = 0;
    let frameH = 0;
    let buf: Uint8Array | null = null;
    while (!context.signal.aborted) {
      const now = performance.now();
      const l = layout.value;
      if (l.frameW !== frameW || l.frameH !== frameH) {
        frameW = l.frameW;
        frameH = l.frameH;
        buf = new Uint8Array(frameW * frameH * 4);
      }
      if (!paused.value) stepFrame();
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
      const updateLayout = () => {
        const size = terminal.size();
        layout.value = getNesVideoLayout(size.cols, size.rows);
        scheduler.invalidate();
      };
      const offResize = terminal.on("resize", updateLayout);
      onMounted(updateLayout);
      onBeforeUnmount(() => {
        offResize();
        releaseAll();
      });

      const title = () => {
        if (paused.value) return " NES · PAUSED ";
        if (phase.value === "gameover") return " NES · GAME OVER ";
        if (phase.value === "title") return " NES · SELECT MODE ";
        return " NES · PLAYING ";
      };

      const helpText = () => {
        if (phase.value === "gameover") return "Enter / R=重新开始 · Q/Ctrl+C=退出";
        if (paused.value) return "菜单: 1/Enter=继续 · 2=分享到X · 3=重开 · 4=退出";
        if (profile === "falling") {
          return phase.value === "title"
            ? "↑ ↓ 选择模式 · Enter=Start · P=菜单 · Q/Ctrl+C=退出"
            : "← → / A D 左右移动 · P=菜单 · Q/Ctrl+C=退出";
        }
        return "方向键/WASD=D-pad · Z/J=B · X/K=A · Enter=Start · P=菜单 · Q/Ctrl+C=退出";
      };

      return () => {
        const l = layout.value;
        const gameOver = phase.value === "gameover";
        const gameOverVideoH = gameOver ? Math.max(4, l.videoH - 5) : l.videoH;
        const panelY = gameOverVideoH;
        const report = analysis.value;

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
              h: gameOverVideoH,
              src: "nes://frame",
              frameSource,
              pixelWidth: l.frameW,
              pixelHeight: l.frameH,
              maxFps: TARGET_FPS,
              fallback: "[NES — this terminal lacks a graphics protocol]",
              style: { bg: "black" },
            }),
            ...(gameOver
              ? [
                  h(TText, {
                    x: 0,
                    y: panelY,
                    w: l.contentW,
                    value: report
                      ? `本局分析 · ${report.mode} · 分数 ${report.score} · 生存 ${report.survivalSeconds.toFixed(1)}s`
                      : "本局分析",
                    style: { fg: "greenBright", bold: true, bg: "black" },
                  }),
                  h(TText, {
                    x: 0,
                    y: panelY + 1,
                    w: l.contentW,
                    value: report
                      ? `移动 ${report.moveInputs} 次 · 变向 ${report.directionChanges} 次 · ${report.summary}`
                      : "正在汇总本局数据…",
                    style: { fg: "white", bg: "black" },
                  }),
                  h(
                    TView,
                    {
                      x: 0,
                      y: panelY + 2,
                      w: Math.min(26, l.contentW),
                      h: 1,
                      zIndex: 10,
                      focusable: true,
                      onClick: () => restartHandler?.(),
                    },
                    () =>
                      h(TText, {
                        x: 0,
                        y: 0,
                        w: Math.min(26, l.contentW),
                        value: "[ Enter / R ]  RESTART",
                        style: { fg: "black", bg: "greenBright", bold: true },
                      }),
                  ),
                ]
              : []),
            h(TText, {
              x: 0,
              y: l.helpY,
              w: l.contentW,
              value: helpText(),
              style: { fg: "white", dim: true, bg: "black" },
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
    queueControlPulse,
    usesPulseInput: (key: NesButton) => profile === "falling" && (key === "up" || key === "down"),
    stepFrame,
    releaseAll,
    reset,
    getRomInfo,
    pause: () => void (paused.value = !paused.value),
    setPaused: (value: boolean) => void (paused.value = value),
    isPaused: () => paused.value,
    isGameOver: () => phase.value === "gameover",
    getPhase: () => phase.value,
    getAnalysis: () => analysis.value,
    setRestartHandler: (handler: () => void) => void (restartHandler = handler),
    frameSnapshot: () => {
      const out = new Uint8Array(NES_VISIBLE_W * NES_VISIBLE_H * 4);
      cropToVisible(nes.ppu.buffer, out);
      return out;
    },
  };
}
