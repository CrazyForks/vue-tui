import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTerminalApp } from "../../src/cli.js";
import { nextTick } from "vue";
import Controller from "./vendor/jsnes/src/controller.js";
import { createNesVideoGame, getNesVideoLayout } from "./nes-video-game.js";

const romPath = fileURLToPath(new URL("./roms/falling.nes", import.meta.url));
const rom = new Uint8Array(readFileSync(romPath));

type CpuMemory = { cpu: { mem: Uint8Array }; crashed?: boolean };
type Game = ReturnType<typeof createNesVideoGame>;
const ram = (game: Game): Uint8Array => (game.nes as unknown as CpuMemory).cpu.mem;
const normalizedSnapshot = (game: Game): string => {
  const app = createTerminalApp({
    cols: 100,
    rows: 30,
    component: game.component,
    defaultStyle: { fg: "white", bg: "black" },
  });
  app.mount();
  app.scheduler.flushNow();
  const snapshot = app.terminal.snapshot().lines.join("\n").replaceAll(" ", "");
  app.dispose();
  return snapshot;
};

function warmTitle(game: Game): void {
  for (let frame = 0; frame < 60; frame++) game.stepFrame();
}

// Real ROM-frame check: two keydowns received together must be delivered as
// press -> neutral -> press. Checking only the controller's final state (the
// old test) cannot prove that Falling's button latch observed both edges.
const repeatedDownGame = createNesVideoGame({ rom, profile: "falling" });
warmTitle(repeatedDownGame);
repeatedDownGame.queueControlPulse("down");
repeatedDownGame.queueControlPulse("down");
repeatedDownGame.stepFrame();
const firstDownMoved = ram(repeatedDownGame)[0x0b] === 1;
const firstDownVisible = repeatedDownGame.nes.controllers[1].state[Controller.BUTTON_DOWN] === 0x41;
repeatedDownGame.stepFrame();
const repeatedDownNeutral =
  repeatedDownGame.nes.controllers[1].state[Controller.BUTTON_DOWN] === 0x40;
repeatedDownGame.stepFrame();
const secondDownMoved = ram(repeatedDownGame)[0x0b] === 2;
const secondDownVisible =
  repeatedDownGame.nes.controllers[1].state[Controller.BUTTON_DOWN] === 0x41;

// The reported Down -> Up sequence also needs the neutral frame, otherwise the
// ROM's shared Up/Down latch treats the second direction as still held.
const downUpGame = createNesVideoGame({ rom, profile: "falling" });
warmTitle(downUpGame);
downUpGame.queueControlPulse("down");
downUpGame.queueControlPulse("up");
downUpGame.stepFrame();
const downBeforeUpMoved = ram(downUpGame)[0x0b] === 1;
downUpGame.stepFrame();
const downUpNeutral =
  downUpGame.nes.controllers[1].state[Controller.BUTTON_DOWN] === 0x40 &&
  downUpGame.nes.controllers[1].state[Controller.BUTTON_UP] === 0x40;
downUpGame.stepFrame();
const immediateUpMoved = ram(downUpGame)[0x0b] === 0;
const immediateUpVisible = downUpGame.nes.controllers[1].state[Controller.BUTTON_UP] === 0x41;

// Verify the bundled game's phase-specific hints instead of checking a Game
// Over screen that does not render movement controls.
const titleUiGame = createNesVideoGame({ rom, profile: "falling", cols: 100, rows: 30 });
warmTitle(titleUiGame);
const titleSnapshot = normalizedSnapshot(titleUiGame);
const titleControlsAccurate =
  titleSnapshot.includes("↑↓选择模式") &&
  titleSnapshot.includes("Enter=Start") &&
  !titleSnapshot.includes("WASD") &&
  !titleSnapshot.includes("射击") &&
  !titleSnapshot.includes("跳跃");

const playingUiGame = createNesVideoGame({ rom, profile: "falling", cols: 100, rows: 30 });
warmTitle(playingUiGame);
playingUiGame.setControl("start", true);
playingUiGame.stepFrame();
playingUiGame.setControl("start", false);
const playingSnapshot = normalizedSnapshot(playingUiGame);
const playingControlsAccurate =
  playingUiGame.getPhase() === "playing" &&
  playingSnapshot.includes("←→/AD左右移动") &&
  !playingSnapshot.includes("WASD") &&
  !playingSnapshot.includes("射击") &&
  !playingSnapshot.includes("跳跃");

// Falling exposes its state in zero-page RAM. Force a deterministic Game Over
// host transition, then verify analysis, resize geometry, the click hitbox, and
// real ROM execution after restart.
const gameOverGame = createNesVideoGame({ rom, profile: "falling", cols: 100, rows: 30 });
warmTitle(gameOverGame);
const gameOverRam = ram(gameOverGame);
gameOverRam[0x00] = 3;
gameOverRam[0x0b] = 2;
gameOverRam[0x1b] = 0x01;
gameOverRam[0x1c] = 0x23;
gameOverGame.stepFrame();
const gameOverDetected = gameOverGame.isGameOver();
const gameOverAnalysis = gameOverGame.getAnalysis();
const analysisReadsRom = gameOverAnalysis?.mode === "Night" && gameOverAnalysis.score === 0x0123;

const app = createTerminalApp({
  cols: 100,
  rows: 30,
  component: gameOverGame.component,
  defaultStyle: { fg: "white", bg: "black" },
});
app.mount();
app.scheduler.flushNow();
const snapshot = app.terminal.snapshot().lines.join("\n");
const analysisVisible = snapshot.includes("Night") && snapshot.includes("291");
const restartVisible = snapshot.includes("RESTART");

app.terminal.resize(80, 24);
await nextTick();
app.scheduler.flushNow();
const resizedLines = app.terminal.snapshot().lines;
const actualBoxFillsAfterResize =
  resizedLines.length === 24 &&
  resizedLines[0]?.startsWith("┌") === true &&
  resizedLines[0]?.endsWith("┐") === true &&
  resizedLines[23]?.startsWith("└") === true &&
  resizedLines[23]?.endsWith("┘") === true;
const restartRow = resizedLines.findIndex((line) => line.includes("RESTART"));
const restartCol = restartRow >= 0 ? resizedLines[restartRow]!.indexOf("[") : -1;
gameOverGame.setRestartHandler(() => gameOverGame.reset());
if (restartRow >= 0 && restartCol >= 0) {
  app.events.dispatch({ type: "click", cellX: restartCol, cellY: restartRow });
}
const restartButtonDispatched = gameOverGame.getPhase() === "title";

let restartRunsFrames = true;
try {
  warmTitle(gameOverGame);
} catch {
  restartRunsFrames = false;
}
const restartReturnsToTitle =
  restartRunsFrames &&
  gameOverGame.getPhase() === "title" &&
  ram(gameOverGame)[0x00] === 0 &&
  (gameOverGame.nes as unknown as CpuMemory).crashed !== true;
gameOverGame.queueControlPulse("down");
gameOverGame.stepFrame();
const restartedModeIsInteractive = ram(gameOverGame)[0x0b] === 1;
app.dispose();

const fullLayout = getNesVideoLayout(100, 30);
const boxFillsTerminal = fullLayout.boxW === 100 && fullLayout.boxH === 30;
const videoFillsContent =
  fullLayout.videoX === 0 &&
  fullLayout.videoY === 0 &&
  fullLayout.videoW === fullLayout.contentW &&
  fullLayout.videoH === fullLayout.helpY;

const checks = {
  firstDownMoved,
  firstDownVisible,
  repeatedDownNeutral,
  secondDownMoved,
  secondDownVisible,
  downBeforeUpMoved,
  downUpNeutral,
  immediateUpMoved,
  immediateUpVisible,
  titleControlsAccurate,
  playingControlsAccurate,
  gameOverDetected,
  analysisReadsRom,
  analysisVisible,
  restartVisible,
  actualBoxFillsAfterResize,
  restartButtonDispatched,
  restartReturnsToTitle,
  restartedModeIsInteractive,
  boxFillsTerminal,
  videoFillsContent,
};
const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify(checks, null, 2));
console.log(ok ? "nes input/ui integration: OK" : "nes input/ui integration: FAILED");
process.exit(ok ? 0 : 1);
