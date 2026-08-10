/**
 * Terminal Contra (魂斗罗) — CLI Runner
 *
 * Interactive:  tsx examples/contra-terminal.ts       (or bun run run:contra:terminal)
 * Smoke:        VT_SMOKE=1 tsx examples/contra-terminal.ts
 *
 * The game itself lives in examples/contra/ (engine.ts + ContraGame.ts). This
 * runner is a thin terminal app on top of vue-tui's createTerminalApp, stdout
 * renderer and stdin driver — the same wiring as examples/chat-cli.ts.
 */
import { nextTick } from "vue";
import {
  createStdinDriver,
  createStdoutRenderer,
  createTerminalApp,
  installTerminalCleanup,
  type TerminalCleanupHandle,
} from "../src/cli.js";
import { createContraGame } from "./contra/ContraGame.js";
import { GAME_TICK_MS } from "./contra/engine.js";

const smoke = process.env.VT_SMOKE === "1";
const interactive = !smoke;
const MIN_COLS = 64;
const MIN_ROWS = 22;
const SMOKE_COLS = 76;
const SMOKE_ROWS = 24;

function liveCols(): number {
  const v = Number(process.stdout.columns);
  return Number.isFinite(v) && v > 0 ? Math.max(MIN_COLS, v) : 80;
}
function liveRows(): number {
  const v = Number(process.stdout.rows);
  return Number.isFinite(v) && v > 0 ? Math.max(MIN_ROWS, v) : 24;
}

const cols = smoke ? SMOKE_COLS : liveCols();
const rows = smoke ? SMOKE_ROWS : liveRows();

const { component, engine, refresh } = createContraGame({
  cols: cols - 2,
  rows: rows - 2,
  seed: smoke ? 20260809 : undefined,
  speedScale: smoke ? 3 : 1,
  firstSpawnMs: smoke ? 200 : undefined,
  autoRun: !smoke,
});

const app = createTerminalApp({
  cols,
  rows,
  component,
  defaultStyle: { fg: "whiteBright" },
});
app.mount();
app.scheduler.flush();

const rendererChunks: string[] = [];
const out = createStdoutRenderer(
  app.terminal,
  smoke
    ? {
        output: {
          isTTY: false,
          write(chunk: string) {
            rendererChunks.push(chunk);
          },
        },
        clear: false,
        hideCursor: false,
        altScreen: false,
        trackResize: false,
      }
    : {
        output: process.stdout,
        hideCursor: true,
        altScreen: true,
        clear: true,
        trackResize: false,
      },
);
app.scheduler.flush();

let driver: ReturnType<typeof createStdinDriver> | null = null;
let cleanupHandle: TerminalCleanupHandle | null = null;
let exiting = false;

const onResize = () => {
  if (smoke) return;
  const nextCols = Math.max(MIN_COLS, liveCols());
  const nextRows = Math.max(MIN_ROWS, liveRows());
  if (nextCols === cols && nextRows === rows) return;
  app.terminal.resize(nextCols, nextRows);
  app.scheduler.flush();
  out.forceRender();
};

const cleanup = () => {
  if (exiting) return;
  exiting = true;
  if (process.stdout.isTTY) process.stdout.off("resize", onResize);
  cleanupHandle?.uninstall();
  cleanupHandle = null;
  driver?.dispose();
  out.dispose();
  app.dispose();
};

const exit = (status = 0) => {
  cleanup();
  process.exit(status);
};

if (process.stdout.isTTY) {
  process.stdout.on("resize", onResize);
}

function pumpTicks(count: number): void {
  for (let i = 0; i < count; i++) {
    engine.step(GAME_TICK_MS);
    refresh();
    app.scheduler.flush();
  }
}

async function runSmoke(): Promise<void> {
  // Let Vue mount the component and settle the first flush before driving.
  await nextTick();
  app.scheduler.flush();

  // Walk right, jump while moving, then walk left and turn back to face the
  // enemies that spawn on the right.
  engine.pressKey("ArrowRight");
  pumpTicks(40);
  engine.pressKey(" ");
  pumpTicks(20);
  engine.pressKey("ArrowLeft");
  pumpTicks(25);
  engine.pressKey("ArrowRight");

  // Hold fire until a grunt dies (bullet speed is scaled 3x in smoke).
  let fireSteps = 0;
  while (engine.snapshot().kills === 0 && fireSteps < 400) {
    engine.pressKey("j");
    engine.step(GAME_TICK_MS);
    refresh();
    app.scheduler.flush();
    fireSteps += 1;
  }

  // Pause must freeze the simulation; resume must continue it.
  const beforePause = engine.snapshot();
  engine.pressKey("p");
  engine.step(GAME_TICK_MS);
  const whilePaused = engine.snapshot();
  engine.pressKey("p");
  engine.step(GAME_TICK_MS);
  const final = engine.snapshot();

  const result = {
    cols,
    rows,
    phase: final.phase,
    playerX: Math.round(final.player.x),
    playerY: Math.round(final.player.y),
    groundY: final.groundY,
    kills: final.kills,
    score: final.score,
    lives: final.lives,
    stage: final.stage,
    enemyCount: final.enemies.length,
    playerBullets: final.playerBullets.length,
    enemyBullets: final.enemyBullets.length,
    pausedDuring: whilePaused.phase,
    resumed: final.phase === "playing",
    frozenWhilePaused:
      whilePaused.player.x === beforePause.player.x &&
      whilePaused.player.y === beforePause.player.y &&
      whilePaused.enemies.length === beforePause.enemies.length,
    renderedNonEmpty: rendererChunks.length > 0,
  };
  const ok =
    result.phase === "playing" &&
    result.resumed &&
    result.frozenWhilePaused &&
    result.kills >= 1 &&
    result.score >= 100 &&
    result.playerY === final.groundY - 1 &&
    result.renderedNonEmpty;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${ok ? "contra smoke: OK" : "contra smoke: FAILED"}\n`);
  exit(ok ? 0 : 1);
}

if (smoke) {
  await runSmoke();
} else {
  cleanupHandle = installTerminalCleanup(cleanup, { signalPolicy: "exit" });
  driver = createStdinDriver({
    dispatch: (event) => {
      const prevented = app.events.dispatch(event);
      app.scheduler.flush();
      return prevented;
    },
    enableMouse: false,
    onExit: exit,
  });
}
