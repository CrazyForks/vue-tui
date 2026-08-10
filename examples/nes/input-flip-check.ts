/**
 * Headless controller-state verification for the no-keyup input model.
 *
 * Simulates the terminal input stream (keydown only, with repeat) and checks
 * that the jsnes controller state flips correctly between directions — the
 * exact bug Simon hit (stuck moving left after pressing left).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import NES from "./vendor/jsnes/src/nes.js";
import Controller from "./vendor/jsnes/src/controller.js";

const romPath = fileURLToPath(new URL("./roms/falling.nes", import.meta.url));
const nes = new NES({ emulateSound: false });
nes.loadROM(new Uint8Array(readFileSync(romPath)));

type Key = "left" | "right" | "up" | "down" | "a" | "b" | "start" | "select";
const BTN: Record<Key, number> = {
  left: Controller.BUTTON_LEFT,
  right: Controller.BUTTON_RIGHT,
  up: Controller.BUTTON_UP,
  down: Controller.BUTTON_DOWN,
  a: Controller.BUTTON_A,
  b: Controller.BUTTON_B,
  start: Controller.BUTTON_START,
  select: Controller.BUTTON_SELECT,
};

const HOLD_RELEASE_MS = 700;
const lastDown = new Map<Key, number>();
const held = new Set<Key>();

function press(key: Key, now: number) {
  if (key === "left") release("right", now);
  if (key === "right") release("left", now);
  if (key === "up") release("down", now);
  if (key === "down") release("up", now);
  if (!held.has(key)) {
    held.add(key);
    nes.buttonDown(1, BTN[key]);
  }
  lastDown.set(key, now);
}

function release(key: Key, now: number) {
  if (!held.has(key)) return;
  nes.buttonUp(1, BTN[key]);
  held.delete(key);
  lastDown.delete(key);
}

function idle(now: number) {
  for (const key of [...held]) {
    const last = lastDown.get(key);
    if (last != null && now - last > HOLD_RELEASE_MS) release(key, now);
  }
}

// Scenario: press left → repeat left → release (no more keydowns) → press right.
let t = 0;
press("left", t);              // t=0 press left
t += 30; press("left", t);     // repeat while held
t += 30; press("left", t);
t += HOLD_RELEASE_MS + 100; idle(t);  // released: button must now be up
const leftReleased = nes.controllers[1].state[BTN.left] === 0x40;

press("right", t);             // press right
t += 30; press("right", t);
const rightHeld = nes.controllers[1].state[BTN.right] === 0x41;
const leftStillUp = nes.controllers[1].state[BTN.left] === 0x40;

const ok = leftReleased && rightHeld && leftStillUp;
console.log(JSON.stringify({ leftReleased, rightHeld, leftStillUp, leftState: nes.controllers[1].state[BTN.left], rightState: nes.controllers[1].state[BTN.right] }, null, 2));
console.log(ok ? "nes input flip: OK" : "nes input flip: FAILED");
process.exit(ok ? 0 : 1);