/**
 * Terminal Contra (魂斗罗) — Vue render component.
 *
 * Renders the engine snapshot into the terminal buffer with vue-tui
 * primitives (TView/TBox/TText). The engine (engine.ts) owns all simulation
 * state; this component only maps snapshot → cells:
 *
 * - HUD: score / hi-score / lives / stage + control hints
 * - Ground `▔` line + one-way platforms the player can jump onto
 * - Player `O>` / `<O` (cyan) with a `>`/`<` gun (yellow), `^` while rising
 * - Enemies: grunts `M` (red) and riflemen `W` (magenta) that stop and shoot
 * - Bullets `*` (player) / `o` (enemy), explosion frames `* % +`
 * - Game-over / paused overlays
 *
 * The component drives `engine.step()` on a 30fps tick when `autoRun` is on;
 * in smoke mode the CLI runner steps the engine and flushes itself.
 */
import type { VNode } from "vue";
import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref } from "vue";
import { TBox, TText, TView, useTerminal } from "../../src/vue.js";
import {
  ContraEngine,
  GAME_TICK_MS,
  type ContraGameOptions,
  type ContraSnapshot,
  type EnemyState,
} from "./engine.js";

const BLINK_MS = 90;
const EXPLOSION_PHASES = ["*", "%", "+"] as const;
const EXPLOSION_STYLES = [
  { fg: "yellow", bold: true },
  { fg: "yellowBright", bold: true },
  { fg: "redBright", bold: true },
] as const;

interface KeyLike {
  key?: string;
  repeat?: boolean;
}

type TextStyle = { fg: string; bold?: boolean; dim?: boolean };

function padScore(value: number): string {
  return String(Math.min(999999, Math.max(0, value))).padStart(6, "0");
}

function explosionPhase(t: number): number {
  return t < 80 ? 0 : t < 160 ? 1 : 2;
}

/** Player's body visible during invincibility blink (2-cell sprite). */
function playerBlinkVisible(s: ContraSnapshot): boolean {
  return s.player.invincibleMs <= 0 || Math.floor(s.now / BLINK_MS) % 2 === 0;
}

export type ContraGameCreateOptions = ContraGameOptions & {
  /** Start the internal 30fps tick loop (off for smoke tests). */
  autoRun?: boolean;
};

export function createContraGame(options: ContraGameCreateOptions) {
  const engine = new ContraEngine(options);
  const autoRun = options.autoRun !== false;
  /** Bumped by whoever drives ticks (component timer or CLI runner) so the
   *  render function re-reads the engine snapshot. */
  const bump: { run: () => void } = { run: () => {} };

  const component = defineComponent({
    name: "ContraGame",
    setup() {
      const { terminal, scheduler } = useTerminal();
      const size = ref(terminal.size());
      const revision = ref(0);
      let timer: ReturnType<typeof setInterval> | null = null;

      const offResize = terminal.on("resize", () => {
        size.value = terminal.size();
        engine.resize(Math.max(0, size.value.cols - 2), Math.max(0, size.value.rows - 2));
        revision.value += 1;
        scheduler.invalidate();
      });

      onMounted(() => {
        // Playfield = bordered box content (border consumes one cell per side).
        engine.resize(Math.max(0, size.value.cols - 2), Math.max(0, size.value.rows - 2));
        bump.run = () => {
          revision.value += 1;
          scheduler.invalidate();
        };
        bump.run();
        if (autoRun) {
          timer = setInterval(() => {
            engine.step(GAME_TICK_MS);
            bump.run();
            scheduler.flush();
          }, GAME_TICK_MS);
        }
      });

      onBeforeUnmount(() => {
        if (timer) clearInterval(timer);
        offResize();
      });

      const snap = computed<ContraSnapshot>(() => {
        void revision.value;
        return engine.snapshot();
      });

      const cols = computed(() => Math.max(2, size.value.cols));
      const rows = computed(() => Math.max(2, size.value.rows));
      const contentW = computed(() => Math.max(1, cols.value - 2));
      const contentH = computed(() => Math.max(1, rows.value - 2));

      const onKeydown = (event: KeyLike): void => {
        engine.pressKey(event?.key ?? "");
        revision.value += 1;
      };

      // ── render helpers (pure functions of the snapshot) ──────────────────

      function renderEnemy(e: EnemyState): VNode {
        const char = e.hitFlashMs > 0 ? "+" : e.kind === "grunt" ? "M" : "W";
        return h(TText, {
          key: `enemy-${e.id}`,
          x: Math.floor(e.x),
          y: Math.round(e.y),
          value: char,
          style: {
            fg: e.kind === "grunt" ? "redBright" : "magentaBright",
            bold: true,
          },
          depsKey: e.hitFlashMs > 0 ? "flash" : "calm",
        });
      }

      function renderPlayer(s: ContraSnapshot): VNode[] {
        const p = s.player;
        const x = Math.floor(p.x);
        const y = Math.round(p.y);
        const visible = playerBlinkVisible(s);
        const head = p.facing > 0 ? x : x + 1;
        const gun = p.facing > 0 ? x + 1 : x;
        const out: VNode[] = [
          h(TText, {
            key: "player-head",
            x: head,
            y,
            value: visible ? "O" : " ",
            style: { fg: "cyanBright", bold: true },
          }),
          h(TText, {
            key: "player-gun",
            x: gun,
            y,
            value: visible ? (p.facing > 0 ? ">" : "<") : " ",
            style: { fg: "yellowBright", bold: true },
          }),
        ];
        // Rising indicator above the gun while jumping.
        if (visible && !p.onGround && p.vy < 0 && y > 2) {
          out.push(
            h(TText, {
              key: "player-rise",
              x: gun,
              y: y - 1,
              value: "^",
              style: { fg: "whiteBright", bold: true },
            }),
          );
        }
        return out;
      }

      function renderOverlay(lines: string[], w: number, hgt: number, style: TextStyle): VNode[] {
        const width = Math.max(...lines.map((l) => l.length));
        const x = Math.max(0, Math.floor((w - width) / 2));
        const y = Math.max(0, Math.floor((hgt - lines.length) / 2));
        return [
          h(TText, {
            key: "overlay",
            x,
            y,
            w: width,
            value: lines.join("\n"),
            style,
            depsKey: "overlay",
          }),
        ];
      }

      return () => {
        const s = snap.value;
        const playW = contentW.value;
        const playH = contentH.value;
        const nodes: VNode[] = [];

        // HUD.
        nodes.push(
          h(TText, {
            key: "hud-score",
            x: 0,
            y: 0,
            w: playW,
            value: `SCORE ${padScore(s.score)}   HI ${padScore(s.hiScore)}   LIVES ${s.lives}   STAGE ${s.stage}`,
            style: { fg: "whiteBright", bold: true },
          }),
          h(TText, {
            key: "hud-help",
            x: 0,
            y: 1,
            w: playW,
            value: "←→ / AD 移动 · ↑ / W / SPACE 跳跃 · J / Z 射击 · P 暂停 · Enter 重开",
            style: { fg: "gray", dim: true },
          }),
        );

        // Ground line.
        nodes.push(
          h(TText, {
            key: "ground",
            x: 0,
            y: s.groundY,
            w: playW,
            value: "▔".repeat(playW),
            style: { fg: "green" },
          }),
        );

        // One-way platforms.
        for (const p of s.platforms) {
          nodes.push(
            h(TText, {
              key: `platform-${p.x}-${p.y}`,
              x: p.x,
              y: p.y,
              w: p.w,
              value: "▔".repeat(p.w),
              style: { fg: "cyan" },
            }),
          );
        }

        // Enemies.
        for (const e of s.enemies) nodes.push(renderEnemy(e));

        // Player.
        nodes.push(...renderPlayer(s));

        // Bullets.
        for (const b of s.playerBullets) {
          nodes.push(
            h(TText, {
              key: `pb-${b.id}`,
              x: Math.floor(b.x),
              y: Math.round(b.y),
              value: "*",
              style: { fg: "yellowBright", bold: true },
            }),
          );
        }
        for (const b of s.enemyBullets) {
          nodes.push(
            h(TText, {
              key: `eb-${b.id}`,
              x: Math.floor(b.x),
              y: Math.round(b.y),
              value: "o",
              style: { fg: "redBright", bold: true },
            }),
          );
        }

        // Explosions.
        for (const ex of s.explosions) {
          const phase = explosionPhase(ex.t);
          nodes.push(
            h(TText, {
              key: `ex-${ex.id}`,
              x: ex.x,
              y: ex.y,
              value: EXPLOSION_PHASES[phase],
              style: EXPLOSION_STYLES[phase] as TextStyle,
            }),
          );
        }

        // Overlays.
        if (s.phase === "gameover") {
          nodes.push(
            ...renderOverlay(
              ["GAME OVER", "", `SCORE ${padScore(s.score)}`, "", "PRESS ENTER TO RETRY"],
              playW,
              playH,
              { fg: "redBright", bold: true },
            ),
          );
        } else if (s.phase === "paused") {
          nodes.push(
            ...renderOverlay(["PAUSED", "", "PRESS P TO RESUME"], playW, playH, {
              fg: "yellowBright",
              bold: true,
            }),
          );
        }

        return h(
          TView,
          {
            x: 0,
            y: 0,
            w: cols.value,
            h: rows.value,
            focusable: true,
            autoFocus: true,
            onKeydown,
          },
          () =>
            h(
              TBox,
              {
                x: 0,
                y: 0,
                w: cols.value,
                h: rows.value,
                border: true,
                title: "CONTRA · 魂斗罗",
                padding: 0,
                style: { fg: "greenBright" },
              },
              () => nodes,
            ),
        );
      };
    },
  });

  return {
    component,
    engine,
    /** Kick a render: re-read the engine snapshot and schedule a flush.
     * Safe to call from the runner (smoke tests) at any time after mount. */
    refresh: () => bump.run(),
  };
}
