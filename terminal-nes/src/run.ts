/**
 * terminal-nes — main runner.
 *
 * Loads a NES ROM (default: the bundled MIT homebrew "Falling") and streams its
 * visible 256×224 frames into the terminal graphics protocol (kitty / iTerm2 /
 * sixel) via TVideo. Keyboard maps to the NES controller.
 *
 * ROM resolution:
 *   1. VUE_TUI_NES_ROM env override (error if missing)
 *   2. VUE_TUI_NES_RANDOM=1 → random .nes from the roms dir
 *   3. user-placed roms/contra.nes (next to the CLI) if present
 *   4. bundled assets/falling.nes
 *
 * Share: press S → screenshot PNG + system clipboard + open X composer.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createStdinDriver,
  createStdoutRenderer,
  createTerminalApp,
  detectTerminalGraphicsCapabilities,
  installTerminalCleanup,
  type TerminalCleanupHandle,
} from "@simon_he/vue-tui/cli";
import {
  createNesVideoGame,
  NES_VISIBLE_H,
  NES_VISIBLE_W,
  type NesButton,
} from "./nes-video-game.js";
import { encodeRgbaPng } from "./png.js";
import {
  copyPngToClipboard,
  getLeaderboard,
  listRoms,
  openBrowserToX,
  shareToX,
  VUE_TUI_URL,
} from "./share.js";

const smoke = process.env.VT_SMOKE === "1";
const defaultRom = fileURLToPath(new URL("../assets/falling.nes", import.meta.url));
const contraRom = fileURLToPath(new URL("../roms/contra.nes", import.meta.url));
const romsDirDefault = fileURLToPath(new URL("../roms", import.meta.url));

function checkTerminalSupport(): boolean {
  if (smoke) return true;
  const caps = detectTerminalGraphicsCapabilities();
  if (caps.supported) return true;
  process.stderr.write(
    [
      "",
      "  ╔══════════════════════════════════════════════════════════════╗",
      "  ║                                                              ║",
      "  ║   🎮  terminal-nes                                           ║",
      "  ║                                                              ║",
      "  ║   ⚠  This terminal does not support graphics protocols.     ║",
      `  ║      Reason: ${caps.reason ?? "unknown"}`,
      "  ║                                                              ║",
      "  ║   Supported terminals:                                       ║",
      "  ║     • Kitty           (kitty)                               ║",
      "  ║     • iTerm2          (iterm2)                              ║",
      "  ║     • WezTerm         (kitty-compatible)                     ║",
      "  ║     • Ghostty         (kitty-compatible)                     ║",
      "  ║     • Any Sixel terminal                                     ║",
      "  ║                                                              ║",
      "  ║   To force detection:                                        ║",
      "  ║     VUE_TUI_GRAPHICS_FORCE=1 terminal-nes                    ║",
      "  ║                                                              ║",
      "  ╚══════════════════════════════════════════════════════════════╝",
      "",
    ].join("\n"),
  );
  return false;
}

export async function runNes(): Promise<void> {
  if (!checkTerminalSupport()) process.exit(1);

  const romsDir =
    process.env.VUE_TUI_NES_ROMS_DIR && existsSync(process.env.VUE_TUI_NES_ROMS_DIR)
      ? process.env.VUE_TUI_NES_ROMS_DIR
      : romsDirDefault;

  let romPath: string;
  if (process.env.VUE_TUI_NES_ROM) {
    romPath = process.env.VUE_TUI_NES_ROM;
    if (!existsSync(romPath)) {
      process.stderr.write(`[nes] VUE_TUI_NES_ROM not found: ${romPath}\n`);
      process.exit(2);
    }
  } else if (process.env.VUE_TUI_NES_RANDOM === "1") {
    const candidates = listRoms(romsDir);
    if (candidates.length === 0) {
      process.stderr.write(
        "[nes] VUE_TUI_NES_RANDOM=1 but no .nes files in roms dir. Put your own (legally owned) ROMs there.\n",
      );
      process.exit(2);
    }
    romPath = candidates[Math.floor(Math.random() * candidates.length)]!;
  } else if (existsSync(contraRom)) {
    romPath = contraRom;
  } else {
    romPath = defaultRom;
  }

  const romBytes = readFileSync(romPath);
  if (
    romBytes.length < 16 ||
    romBytes[0] !== 0x4e ||
    romBytes[1] !== 0x45 ||
    romBytes[2] !== 0x53 ||
    romBytes[3] !== 0x1a
  ) {
    process.stderr.write(
      `[nes] invalid ROM at ${romPath} (expected an iNES .nes file). ` +
        `Set VUE_TUI_NES_ROM to your own ROM.\n`,
    );
    process.exit(2);
  }
  const rom = new Uint8Array(romBytes);

  const cols = smoke ? 100 : Math.max(48, Number(process.stdout.columns) || 100);
  const rows = smoke ? 30 : Math.max(16, Number(process.stdout.rows) || 30);

  const game = createNesVideoGame({ rom, cols, rows });

  if (!smoke) {
    const info = game.getRomInfo();
    process.stderr.write(`[nes] ROM: ${romPath}\n`);
    process.stderr.write(
      `[nes] mapper=${info.mapper}${info.mapperSupported ? " (supported)" : " (UNSUPPORTED!)"} ` +
        `prg=${info.prgPages}×16KB chr=${info.chrPages}×4KB mirror=${info.mirroring}\n`,
    );
    if (!info.mapperSupported) {
      process.stderr.write(
        "[nes] warning: this mapper is not supported by the bundled jsnes core; the game may fail to run.\n",
      );
    }
    const top = getLeaderboard().slice(0, 5);
    if (top.length > 0) {
      process.stderr.write(
        `[nes] 🏆 leaderboard — press S to share & compete:\n` +
          top
            .map(
              (e, i) =>
                `[nes]   ${i + 1}. ${e.player.padEnd(16)} score ${String(e.score).padStart(6)} ` +
                `${(e.playMs / 1000).toFixed(1)}s ${e.rom}`,
            )
            .join("\n") +
          "\n",
      );
    } else {
      process.stderr.write(
        "[nes] press S anytime to screenshot + share to X and join the local leaderboard.\n",
      );
    }
    process.stderr.write(`[nes] repo: ${VUE_TUI_URL}\n`);
  }

  const app = createTerminalApp({
    cols,
    rows,
    component: game.component,
    defaultStyle: { fg: "white", bg: "black" },
  });
  app.mount();
  app.scheduler.flush();

  const out = createStdoutRenderer(
    app.terminal,
    smoke
      ? {
          output: { isTTY: false, write() {} },
          clear: false,
          hideCursor: false,
          altScreen: false,
          colorMode: "truecolor",
        }
      : {
          output: process.stdout,
          hideCursor: true,
          altScreen: true,
          clear: true,
          colorMode: "truecolor",
        },
  );
  app.scheduler.flush();

  function mapKey(event: { key?: string }): NesButton | null {
    const k = String(event.key ?? "");
    switch (k) {
      case "ArrowUp":
      case "w":
        return "up";
      case "ArrowDown":
      case "s":
        return "down";
      case "ArrowLeft":
      case "a":
        return "left";
      case "ArrowRight":
      case "d":
        return "right";
      case "z":
      case "j":
        return "b";
      case "x":
      case "k":
        return "a";
      case "Enter":
        return "start";
      case "Shift":
      case "ShiftLeft":
      case "ShiftRight":
        return "select";
      default:
        return null;
    }
  }

  if (smoke) {
    // Deterministic smoke: emulate 120 frames headlessly, verify the PPU paints
    // real pixels and the overscan-cropped visible frame encodes into a PNG.
    for (let i = 0; i < 120; i++) game.nes.frame();
    const rgba = game.frameSnapshot(); // 256×224 visible picture
    const png = encodeRgbaPng(rgba, NES_VISIBLE_W, NES_VISIBLE_H);
    let painted = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i]! !== 0 || rgba[i + 1]! !== 0 || rgba[i + 2]! !== 0) painted++;
    }
    const result = { smoke: true, romBytes: romBytes.length, pngBytes: png.length, painted };
    const ok = png.length > 100 && painted > 100;
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.stdout.write(ok ? "nes smoke: OK\n" : "nes smoke: FAILED\n");
    process.exit(ok ? 0 : 1);
  }

  let exiting = false;
  let holdTimer: ReturnType<typeof setInterval> | null = null;
  let driver: ReturnType<typeof createStdinDriver> | null = null;
  let cleanupHandle: TerminalCleanupHandle | null = null;
  const exit = (status = 0): void => {
    if (exiting) return;
    exiting = true;
    if (holdTimer) clearInterval(holdTimer);
    cleanupHandle?.uninstall();
    cleanupHandle = null;
    driver?.dispose();
    out.dispose();
    app.dispose();
    process.exit(status);
  };

  /**
   * Terminal stdin has no keyup events: a held key is signalled by repeated
   * keydown events, and release is only observable as "no more keydowns".
   * Every keydown marks "pressed now"; a button that has not been refreshed
   * for a while is auto-released. Directions are mutually exclusive.
   */
  const HOLD_RELEASE_MS = 700;
  const lastKeydownAt = new Map<NesButton, number>();
  const heldButtons = new Set<NesButton>();

  function releaseNesButton(key: NesButton): void {
    game.setControl(key, false);
    heldButtons.delete(key);
    lastKeydownAt.delete(key);
  }

  function pressNesButton(key: NesButton): void {
    // Direction buttons are mutually exclusive like a real D-pad: the last
    // pressed direction wins and the opposite one releases immediately.
    if (key === "left") releaseNesButton("right");
    else if (key === "right") releaseNesButton("left");
    if (key === "up") releaseNesButton("down");
    else if (key === "down") releaseNesButton("up");
    // A/B/start/select are independent; only the idle-timeout releases them.
    if (!heldButtons.has(key)) {
      heldButtons.add(key);
      game.setControl(key, true);
    }
    lastKeydownAt.set(key, performance.now());
  }

  holdTimer = setInterval(() => {
    const now = performance.now();
    for (const key of [...heldButtons]) {
      const last = lastKeydownAt.get(key);
      if (last != null && now - last > HOLD_RELEASE_MS) releaseNesButton(key);
    }
  }, 50);

  /** S key: capture a frame, save a PNG, copy image + text, open X composer. */
  let playStartedAt = performance.now();
  let shareCooldownUntil = 0;
  const handleShare = (): void => {
    const now = performance.now();
    if (now < shareCooldownUntil) return;
    shareCooldownUntil = now + 2000;
    const wasPaused = game.isPaused();
    game.setPaused(true); // freeze the frame we are screenshotting

    const rgba = game.frameSnapshot();
    const result = shareToX({
      rom: romPath.split("/").pop() ?? romPath,
      player: process.env.VUE_TUI_NES_PLAYER ?? "terminal-player",
      playMs: Math.max(0, now - playStartedAt),
      frameRgba: rgba,
      frameW: NES_VISIBLE_W,
      frameH: NES_VISIBLE_H,
      postfix: "Beat me on the terminal-nes leaderboard!",
    });

    const imgCopied = result.pngPath ? copyPngToClipboard(result.pngPath) : false;
    const opened = openBrowserToX(result.caption);
    const textCopied = result.copied;

    game.setPaused(wasPaused);

    process.stderr.write(
      `\n[nes] 📸 share:\n` +
        `[nes]   browser${opened ? " opened" : " NOT opened — copy the caption manually"} → X composer\n` +
        `[nes]   image${imgCopied ? " copied to clipboard" : " saved to"} ${result.pngPath ?? "—"}\n` +
        `[nes]   caption${textCopied ? " in clipboard" : " below"}\n` +
        `[nes]   rank #${result.rank ?? "-"} of ${result.leaderboard.length} local players\n` +
        `[nes] --- X caption ---\n${result.caption}\n` +
        `[nes] -----------------\n` +
        `[nes] In X: press Cmd/Ctrl+V to paste the screenshot into your post.\n`,
    );
  };

  driver = createStdinDriver({
    keyboardProtocol: "off",
    dispatch: (event) => {
      if (event.type === "keydown") {
        const k = String(event.key ?? "").toLowerCase();
        const isCtrlC = event.ctrlKey === true && k === "c" && !event.metaKey;
        const isQ = k === "q" && !event.ctrlKey && !event.metaKey;
        if (isCtrlC || isQ) {
          exit();
          return true;
        }
        if (k === "p" && !event.ctrlKey && !event.metaKey) {
          game.pause();
          app.scheduler.flush();
          return true;
        }
        if (k === "s" && !event.ctrlKey && !event.metaKey && !event.repeat) {
          handleShare();
          app.scheduler.flush();
          return true;
        }
        const mapped = mapKey(event);
        if (mapped) pressNesButton(mapped);
        app.scheduler.flush();
        return true;
      }
      const prevented = app.events.dispatch(event);
      app.scheduler.flush();
      return prevented;
    },
    enableMouse: false,
    onExit: () => exit(0),
  });

  if (process.stdout.isTTY) {
    cleanupHandle = installTerminalCleanup(() => exit(0), { signalPolicy: "exit" });
    process.stdout.on("resize", () => {
      const nc = Math.max(48, Number(process.stdout.columns) || cols);
      const nr = Math.max(16, Number(process.stdout.rows) || rows);
      if (nc === app.terminal.size().cols && nr === app.terminal.size().rows) return;
      app.terminal.resize(nc, nr);
      app.scheduler.flushNow();
      out.forceRender();
    });
  }
}