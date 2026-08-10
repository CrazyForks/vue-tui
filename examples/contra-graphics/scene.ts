/**
 * Terminal Contra (魂斗罗) — scene rasterizer.
 *
 * Maps a ContraSnapshot (cell-space simulation) onto a pixel canvas for the
 * terminal kitty/iTerm2 graphics pipeline. Canvas layout:
 *   - 6 px wide × 12 px tall per simulation cell
 *   - ground surface = snapshot.groundY * 12
 *   - sprites are anchored by their feet on the cell they occupy
 */
import type { ContraSnapshot } from "../contra/engine.js";
import {
  C,
  CELL_H_PX,
  CELL_W_PX,
  drawSprite,
  drawTextCentered,
  fillCircle,
  fillRect,
  GRUNT_COLORS,
  GRUNT_SPRITES,
  PLAYER_COLORS,
  PLAYER_SPRITES,
  RIFLE_COLORS,
  RIFLE_SPRITES,
  type Rgba,
} from "./art.js";

export const CANVAS_W = 432;
export const CANVAS_H = 288;
export const GROUND_H = 40;

const SCALE = 2;
const BLINK_MS = 90;
const GRUNT_W = 6 * SCALE;
const GRUNT_H = 8 * SCALE;
const RIFLE_W = 7 * SCALE;
const RIFLE_H = 9 * SCALE;
const PLAYER_W = 8 * SCALE;
const PLAYER_H = 12 * SCALE;

/**
 * Render one game frame into an RGBA buffer.
 * `groundScroll` drives the parallax of the jungle layers.
 *
 * When `outW/outH` differ from the internal CANVAS_W×CANVAS_H, the scene is
 * composed at the internal resolution and then nearest-neighbour resampled
 * into `buf` (which must be exactly outW×outH×4 bytes). This maps the frame
 * onto the kitty placement box aspect so the terminal never crops it.
 */
export function renderScene(
  buf: Uint8Array,
  s: ContraSnapshot,
  groundScroll: number,
  outW: number = CANVAS_W,
  outH: number = CANVAS_H,
): void {
  if (outW === CANVAS_W && outH === CANVAS_H) {
    renderSceneAtScale(buf, s, groundScroll);
    return;
  }
  if (buf.byteLength !== outW * outH * 4) {
    throw new Error(
      `renderScene buffer mismatch: expected ${outW * outH * 4}, got ${buf.byteLength}`,
    );
  }
  const work = new Uint8Array(CANVAS_W * CANVAS_H * 4);
  renderSceneAtScale(work, s, groundScroll);
  buf.set(resampleNearest(work, outW, outH));
}

function renderSceneAtScale(buf: Uint8Array, s: ContraSnapshot, groundScroll: number): void {
  const groundTop = s.groundY * CELL_H_PX;
  // Sky.
  fillRect(buf, CANVAS_W, CANVAS_H, 0, 0, CANVAS_W, groundTop, C.skyTop);
  fillRect(buf, CANVAS_W, CANVAS_H, 0, 0, CANVAS_W, Math.floor(groundTop * 0.55), C.skyMid);
  fillRect(buf, CANVAS_W, CANVAS_H, 0, 0, CANVAS_W, Math.floor(groundTop * 0.3), C.skyLow);

  drawCanopy(buf, groundScroll * 0.35);
  drawHills(buf, groundTop, groundScroll * 0.05);
  drawPalmTrees(buf, groundTop, groundScroll * 0.2);
  drawClouds(buf, groundTop, groundScroll * 0.1);
  drawGround(buf, groundTop, groundScroll);

  // Platforms (wood planks).
  for (const p of s.platforms) {
    const x = p.x * CELL_W_PX;
    const y = p.y * CELL_H_PX;
    const w = p.w * CELL_W_PX;
    fillRect(buf, CANVAS_W, CANVAS_H, x, y + 4, w, 10, C.platform);
    fillRect(buf, CANVAS_W, CANVAS_H, x, y + 4, w, 3, C.platformDark);
    fillRect(buf, CANVAS_W, CANVAS_H, x, y + 4, w, 1, C.platformLine);
    // plank seams
    for (let sx = x + 12; sx < x + w - 6; sx += 18) {
      fillRect(buf, CANVAS_W, CANVAS_H, sx, y + 4, 1, 10, C.platformLine);
    }
  }

  // Explosions.
  for (const ex of s.explosions) {
    drawExplosion(buf, ex.x * CELL_W_PX + 3, ex.y * CELL_H_PX + 6, ex.t);
  }

  // Enemy bullets.
  for (const b of s.enemyBullets) {
    const x = b.x * CELL_W_PX + 3;
    const y = (b.y + 0.5) * CELL_H_PX;
    fillCircle(buf, CANVAS_W, CANVAS_H, x, y, 4, C.enemyBullet);
    fillCircle(buf, CANVAS_W, CANVAS_H, x, y, 2, C.enemyBulletCore);
  }

  // Enemies.
  for (const e of s.enemies) {
    if (e.hitFlashMs > 0) {
      drawCellShock(buf, e.x * CELL_W_PX + 3, e.y * CELL_H_PX + 6);
      continue;
    }
    if (e.kind === "grunt") drawGrunt(buf, e.x, e.y, s);
    else drawRifleman(buf, e.x, e.y, s);
  }

  // Player bullets.
  for (const b of s.playerBullets) {
    const x = b.x * CELL_W_PX + 3;
    const y = (b.y + 0.5) * CELL_H_PX;
    fillRect(buf, CANVAS_W, CANVAS_H, x - 6, y - 1, 6, 2, C.bullet);
    fillRect(buf, CANVAS_W, CANVAS_H, x - 2, y - 2, 4, 4, C.bulletCore);
  }

  drawPlayer(
    buf,
    s.player.x,
    s.player.y,
    s.player.facing,
    s.moveAnim,
    s.player.vy,
    s.player.invincibleMs,
    s.now,
  );

  // Overlays.
  if (s.phase === "gameover") {
    drawTextCentered(buf, CANVAS_W, CANVAS_H, "GAME OVER", CANVAS_W / 2, 80, 4, C.redText);
    drawTextCentered(buf, CANVAS_W, CANVAS_H, `SCORE ${s.score}`, CANVAS_W / 2, 130, 2, C.white);
    drawTextCentered(
      buf,
      CANVAS_W,
      CANVAS_H,
      `HI ${s.hiScore}`,
      CANVAS_W / 2,
      160,
      2,
      C.yellowText,
    );
    drawTextCentered(
      buf,
      CANVAS_W,
      CANVAS_H,
      "PRESS ENTER TO RETRY",
      CANVAS_W / 2,
      200,
      2,
      C.greenText,
    );
  } else if (s.phase === "paused") {
    fillRect(buf, CANVAS_W, CANVAS_H, 0, 0, CANVAS_W, CANVAS_H, [8, 14, 12, 140]);
    drawTextCentered(buf, CANVAS_W, CANVAS_H, "PAUSED", CANVAS_W / 2, 110, 3, C.yellowText);
    drawTextCentered(buf, CANVAS_W, CANVAS_H, "PRESS P TO RESUME", CANVAS_W / 2, 170, 2, C.white);
  }
}

function drawCanopy(buf: Uint8Array, offset: number): void {
  // Dense jungle ceiling: overlapping dark foliage lobes along the top.
  const lobe = 26;
  for (let x = -lobe - (offset % lobe); x < CANVAS_W + lobe; x += lobe) {
    fillCircle(buf, CANVAS_W, CANVAS_H, x, 8, 16, C.canopy);
    fillCircle(buf, CANVAS_W, CANVAS_H, x + 12, 22, 15, C.canopyDark);
    fillCircle(buf, CANVAS_W, CANVAS_H, x + lobe / 2, 0, 12, C.canopyDark);
  }
  fillRect(buf, CANVAS_W, CANVAS_H, 0, 0, CANVAS_W, 4, C.canopyDark);
  // Hanging vines.
  for (let x = 24 + ((offset * 2.5) % 90); x < CANVAS_W - 10; x += 90) {
    fillRect(buf, CANVAS_W, CANVAS_H, x, 30, 2, 34, C.canopyDark);
    fillCircle(buf, CANVAS_W, CANVAS_H, x + 1, 68, 3, C.canopyDark);
  }
}

function drawHills(buf: Uint8Array, groundTop: number, offset: number): void {
  const far = [
    { x: -40, w: 160, h: 60 },
    { x: 150, w: 220, h: 84 },
    { x: 390, w: 140, h: 46 },
  ];
  for (const hill of far) {
    const x = hill.x - offset;
    drawHill(buf, x, groundTop, hill.w, hill.h, C.hillFar);
  }
  const near = [
    { x: -30, w: 200, h: 46 },
    { x: 210, w: 260, h: 60 },
  ];
  for (const hill of near) {
    const x = hill.x - offset * 1.4;
    drawHill(buf, x, groundTop, hill.w, hill.h, C.hillNear);
  }
}

function drawHill(buf: Uint8Array, x: number, baseY: number, w: number, h: number, c: Rgba): void {
  const cx = x + w / 2;
  for (let i = 0; i <= w; i++) {
    const dx = (i - w / 2) / (w / 2);
    const y = baseY - Math.round(h * Math.sqrt(1 - dx * dx));
    fillRect(buf, CANVAS_W, CANVAS_H, x + i, y, 1, baseY - y, c);
  }
}

function drawPalmTrees(buf: Uint8Array, groundTop: number, offset: number): void {
  const trees = [
    { x: 30, h: 110 },
    { x: 190, h: 150 },
    { x: 330, h: 120 },
  ];
  for (const t of trees) {
    const x = ((((t.x - offset) % (CANVAS_W + 160)) + CANVAS_W + 160) % (CANVAS_W + 160)) - 80;
    const top = groundTop - t.h;
    // trunk
    fillRect(buf, CANVAS_W, CANVAS_H, x - 2, top + 20, 4, t.h - 24, C.palmTrunk);
    // fronds: arcs of circles
    fillCircle(buf, CANVAS_W, CANVAS_H, x + 14, top + 14, 16, C.palmLeaf);
    fillCircle(buf, CANVAS_W, CANVAS_H, x - 14, top + 12, 14, C.palmLeafDark);
    fillCircle(buf, CANVAS_W, CANVAS_H, x + 2, top + 2, 12, C.palmLeaf);
    fillCircle(buf, CANVAS_W, CANVAS_H, x, top + 18, 8, C.palmLeafDark);
  }
}

function drawClouds(buf: Uint8Array, groundTop: number, offset: number): void {
  const clouds = [
    { x: 50, y: 40, r: 12 },
    { x: 200, y: 26, r: 10 },
    { x: 350, y: 52, r: 9 },
  ];
  for (const cl of clouds) {
    const x = ((((cl.x - offset) % (CANVAS_W + 100)) + CANVAS_W + 100) % (CANVAS_W + 100)) - 50;
    const y = Math.min(cl.y, groundTop - 46);
    fillCircle(buf, CANVAS_W, CANVAS_H, x, y, cl.r, C.cloud);
    fillCircle(buf, CANVAS_W, CANVAS_H, x + cl.r * 0.8, y + 2, cl.r * 0.65, C.cloud);
    fillCircle(buf, CANVAS_W, CANVAS_H, x - cl.r * 0.8, y + 2, cl.r * 0.65, C.cloud);
  }
}

function drawGround(buf: Uint8Array, groundTop: number, offset: number): void {
  fillRect(buf, CANVAS_W, CANVAS_H, 0, groundTop, CANVAS_W, CANVAS_H - groundTop, C.ground);
  fillRect(buf, CANVAS_W, CANVAS_H, 0, groundTop, CANVAS_W, 9, C.grass);
  fillRect(buf, CANVAS_W, CANVAS_H, 0, groundTop + 7, CANVAS_W, 3, C.grassDark);
  // diagonal dirt stripes
  const total = 26;
  for (let x = -((offset % total) + total); x < CANVAS_W; x += total) {
    for (let row = 0; row < CANVAS_H - groundTop - 11; row++) {
      fillRect(buf, CANVAS_W, CANVAS_H, x + row, groundTop + 11 + row, 13, 1, C.groundDark);
    }
  }
}

function drawGrunt(buf: Uint8Array, x: number, y: number, s: ContraSnapshot): void {
  const px = x * CELL_W_PX + 3 - GRUNT_W / 2;
  const py = (y + 1) * CELL_H_PX - GRUNT_H;
  const frame = Math.floor(s.now / 150) % GRUNT_SPRITES.length;
  drawSprite(
    buf,
    CANVAS_W,
    CANVAS_H,
    Math.round(px),
    py,
    GRUNT_SPRITES[frame]!,
    GRUNT_COLORS,
    SCALE,
  );
}

function drawRifleman(buf: Uint8Array, x: number, y: number, s: ContraSnapshot): void {
  const px = x * CELL_W_PX + 3 - RIFLE_W / 2;
  const py = (y + 1) * CELL_H_PX - RIFLE_H;
  const frame = Math.floor(s.now / 150) % RIFLE_SPRITES.length;
  drawSprite(
    buf,
    CANVAS_W,
    CANVAS_H,
    Math.round(px),
    py,
    RIFLE_SPRITES[frame]!,
    RIFLE_COLORS,
    SCALE,
  );
}

function drawPlayer(
  buf: Uint8Array,
  x: number,
  y: number,
  facing: 1 | -1,
  moveAnim: number,
  vy: number,
  invincibleMs: number,
  now: number,
): void {
  // Blink while invincible (dim instead of hiding the sprite entirely).
  const blinkOff = invincibleMs > 0 && Math.floor(now / BLINK_MS) % 2 === 1;
  const px = Math.round(x * CELL_W_PX + 3 - PLAYER_W / 2);
  const py = (y + 1) * CELL_H_PX - PLAYER_H;
  const frame = vy !== 0 ? 2 : moveAnim > 0 ? Math.floor(moveAnim / 160) % 2 : 0;
  const sprite = PLAYER_SPRITES[frame]!;
  drawSprite(buf, CANVAS_W, CANVAS_H, px, py, sprite, PLAYER_COLORS, SCALE, facing === -1);
  if (blinkOff) {
    // semi-transparent white overlay to signal temporary invulnerability
    fillRect(buf, CANVAS_W, CANVAS_H, px, py, PLAYER_W, PLAYER_H, [255, 255, 255, 60] as Rgba);
  }
}

function drawExplosion(buf: Uint8Array, cx: number, cy: number, t: number): void {
  if (t < 80) {
    fillCircle(buf, CANVAS_W, CANVAS_H, cx, cy, 14, [255, 240, 160, 255]);
    fillCircle(buf, CANVAS_W, CANVAS_H, cx, cy, 8, [255, 255, 255, 255]);
  } else if (t < 160) {
    fillCircle(buf, CANVAS_W, CANVAS_H, cx, cy, 15, [255, 170, 60, 255]);
    fillCircle(buf, CANVAS_W, CANVAS_H, cx, cy, 9, [255, 230, 120, 255]);
  } else {
    fillCircle(buf, CANVAS_W, CANVAS_H, cx, cy, 12, [232, 88, 44, 220]);
    fillCircle(buf, CANVAS_W, CANVAS_H, cx, cy, 7, [255, 160, 80, 180]);
  }
}

function drawCellShock(buf: Uint8Array, cx: number, cy: number): void {
  fillCircle(buf, CANVAS_W, CANVAS_H, cx, cy, 12, [255, 255, 255, 220]);
  fillCircle(buf, CANVAS_W, CANVAS_H, cx, cy, 7, [255, 255, 255, 255]);
}

/**
 * Nearest-neighbour resample of an RGBA image. Used to map the 432×288 scene
 * onto the exact kitty placement box pixels so the terminal never crops it.
 */
export function resampleNearest(source: Uint8Array, outW: number, outH: number): Uint8Array {
  const out = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(CANVAS_H - 1, Math.floor((y * CANVAS_H) / outH));
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(CANVAS_W - 1, Math.floor((x * CANVAS_W) / outW));
      const si = (sy * CANVAS_W + sx) * 4;
      const di = (y * outW + x) * 4;
      out[di] = source[si]!;
      out[di + 1] = source[si + 1]!;
      out[di + 2] = source[si + 2]!;
      out[di + 3] = source[si + 3]!;
    }
  }
  return out;
}
