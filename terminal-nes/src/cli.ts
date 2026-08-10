#!/usr/bin/env node
/**
 * terminal-nes — 🎮 Real NES emulator in your terminal
 *
 * Usage:  terminal-nes          (or npx terminal-nes)
 * Keys:
 *   ←↑↓→ / WASD → D-pad   Z/J → B   X/K → A
 *   Enter → Start   Shift → Select   S → share to X   P → pause   Q/Ctrl-C → quit
 *
 * Requires a graphics-protocol terminal: Kitty, iTerm2, WezTerm, Ghostty, or Sixel.
 */
import { runNes } from "./run.js";

runNes().catch((error) => {
  process.stderr.write(`[terminal-nes] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});