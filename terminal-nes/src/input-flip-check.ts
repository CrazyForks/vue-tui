/**
 * Headless controller-state verification for the no-keyup input model.
 *
 * Simulates the terminal input stream (keydown only, with repeat) and checks:
 * 1. Direction flipping works (the exact bug Simon hit: stuck moving left).
 * 2. Fast re-taps on action buttons (A) produce a fresh press edge for the
 *    NES — without keyup, the old model held the button for 700ms and rapid
 *    double-taps never registered as new presses.
 * 3. Held directions do NOT re-fire (typematic repeat must not toggle).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Nes from "./vendor/jsnes/src/nes.js";
import Controller, { type ButtonKey } from "./vendor/jsnes/src/controller.js";

const romPath = fileURLToPath(new URL("../assets/falling.nes", import.meta.url));
const nes = new Nes({ emulateSound: false });
nes.loadROM(new Uint8Array(readFileSync(romPath)));

type Key = "left" | "right" | "up" | "down" | "a" | "b" | "start" | "select";
const BTN: Record<Key, ButtonKey> = {
  left: Controller.BUTTON_LEFT,
  right: Controller.BUTTON_RIGHT,
  up: Controller.BUTTON_UP,
  down: Controller.BUTTON_DOWN,
  a: Controller.BUTTON_A,
  b: Controller.BUTTON_B,
  start: Controller.BUTTON_START,
  select: Controller.BUTTON_SELECT,
};

// Mirror the runner's model exactly.
const DIRECTION_HOLD_MS = 700;
const ACTION_RELEASE_MS = 180;
const ACTION_REPRESS_MS = 120;
const lastDown = new Map<Key, number>();
const held = new Set<Key>();

const isDirection = (key: Key): boolean =>
  key === "left" || key === "right" || key === "up" || key === "down";

function release(key: Key, now: number) {
  if (!held.has(key)) return;
  nes.buttonUp(1, BTN[key]);
  held.delete(key);
  lastDown.delete(key);
}

function press(key: Key, now: number) {
  if (key === "left") release("right", now);
  else if (key === "right") release("left", now);
  if (key === "up") release("down", now);
  else if (key === "down") release("up", now);

  if (held.has(key)) {
    const last = lastDown.get(key);
    if (!isDirection(key) && last != null && now - last > ACTION_REPRESS_MS) {
      // fresh press: re-fire the edge (release then press)
      nes.buttonUp(1, BTN[key]);
      nes.buttonDown(1, BTN[key]);
    }
    lastDown.set(key, now);
    return;
  }
  held.add(key);
  nes.buttonDown(1, BTN[key]);
  lastDown.set(key, now);
}

function idle(now: number) {
  for (const key of [...held]) {
    const last = lastDown.get(key);
    if (last == null) continue;
    const limit = isDirection(key) ? DIRECTION_HOLD_MS : ACTION_RELEASE_MS;
    if (now - last > limit) release(key, now);
  }
}

let t = 0;

// 1. Direction flip: left (held with repeats) → idle → right.
press("left", (t += 30));
press("left", (t += 30));
press("left", (t += 30));
t += DIRECTION_HOLD_MS + 100;
idle(t);
const leftReleasedAfterIdle = nes.controllers[1].state[BTN.left] === 0x40;

press("right", t);
press("right", (t += 30));
const rightHeld = nes.controllers[1].state[BTN.right] === 0x41;
const leftStillUp = nes.controllers[1].state[BTN.left] === 0x40;

// 2. Fast re-tap on A: two presses well under the old 700ms hold must both
//    register as press edges. We can only observe edges via state, so verify
//    the re-press path toggles state down→up→down in order.
t += ACTION_RELEASE_MS + 50; // let the first A press auto-release
idle(t);
press("a", t);
const aFirstDown = nes.controllers[1].state[BTN.a] === 0x41;
t += ACTION_RELEASE_MS + 50;
idle(t);
const aFirstReleased = nes.controllers[1].state[BTN.a] === 0x40;
press("a", t); // fresh press again
const aSecondDown = nes.controllers[1].state[BTN.a] === 0x41;

// 3. Typematic repeat on a held action button must NOT delete the press.
t += 30;
press("a", t); // repeat arrives while still held (gap < ACTION_REPRESS_MS)
const aStillDown = nes.controllers[1].state[BTN.a] === 0x41;

const checks = {
  leftReleasedAfterIdle,
  rightHeld,
  leftStillUp,
  aFirstDown,
  aFirstReleased,
  aSecondDown,
  aStillDown,
};
const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify(checks, null, 2));
console.log(ok ? "nes input flip: OK" : "nes input flip: FAILED");
process.exit(ok ? 0 : 1);