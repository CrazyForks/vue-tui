#!/usr/bin/env node
/**
 * terminal-nes — 🎮 Real NES emulator in your terminal
 *
 * Usage:  terminal-nes          (or npx terminal-nes)
 * Falling: ←/→ or A/D → move, ↑/↓ → select mode, Enter → start
 * Menu: P → open, then 1 resume / 2 share / 3 restart / 4 quit
 *
 * Requires a graphics-protocol terminal: Kitty, iTerm2, WezTerm, Ghostty, or Sixel.
 */
import { runNes } from "./run.js";

runNes().catch((error) => {
  process.stderr.write(
    `[terminal-nes] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
