/**
 * Terminal Contra (魂斗罗) — pixel art toolkit.
 *
 * Pure-JS RGBA rasterizer + PNG encoder (zlib), ported patterns from
 * terminal-flappy-bird: color-mapped ASCII sprites, a 5x7 pixel font, alpha
 * compositing, and a compact PNG writer that deflates scanlines directly.
 * No canvas/DOM/native deps — runs in Node.
 */
import { deflateSync } from "node:zlib";

export type Rgba = readonly [number, number, number, number];

export const CELL_W_PX = 6;
export const CELL_H_PX = 12;

// ── palette ────────────────────────────────────────────────────────────────

export const C = {
  skyTop: [30, 76, 56, 255] as Rgba,
  skyMid: [42, 100, 72, 255] as Rgba,
  skyLow: [52, 122, 84, 255] as Rgba,
  cloud: [170, 220, 190, 90] as Rgba,
  hillFar: [46, 92, 72, 255] as Rgba,
  hillNear: [58, 122, 90, 255] as Rgba,
  canopy: [16, 44, 32, 255] as Rgba,
  canopyDark: [11, 30, 22, 255] as Rgba,
  palmTrunk: [72, 52, 30, 255] as Rgba,
  palmLeaf: [58, 128, 66, 255] as Rgba,
  palmLeafDark: [44, 96, 50, 255] as Rgba,
  ground: [168, 108, 55, 255] as Rgba,
  groundDark: [134, 82, 42, 255] as Rgba,
  grass: [118, 196, 56, 255] as Rgba,
  grassDark: [82, 148, 40, 255] as Rgba,
  platform: [188, 116, 60, 255] as Rgba,
  platformDark: [128, 72, 36, 255] as Rgba,
  platformLine: [74, 42, 22, 255] as Rgba,
  playerSkin: [240, 186, 132, 255] as Rgba,
  playerHair: [78, 56, 36, 255] as Rgba,
  playerBandana: [224, 52, 52, 255] as Rgba,
  playerBody: [64, 142, 216, 255] as Rgba,
  playerBodyDark: [44, 104, 168, 255] as Rgba,
  playerBelt: [196, 118, 52, 255] as Rgba,
  playerBoot: [88, 56, 34, 255] as Rgba,
  gun: [40, 40, 46, 255] as Rgba,
  bullet: [255, 222, 96, 255] as Rgba,
  bulletCore: [255, 250, 214, 255] as Rgba,
  enemyBullet: [255, 96, 72, 255] as Rgba,
  enemyBulletCore: [255, 224, 186, 255] as Rgba,
  gruntHelmet: [150, 160, 172, 255] as Rgba,
  gruntHelmetDark: [104, 112, 124, 255] as Rgba,
  gruntSkin: [236, 190, 140, 255] as Rgba,
  gruntBody: [196, 74, 68, 255] as Rgba,
  gruntBodyDark: [140, 48, 46, 255] as Rgba,
  gruntPants: [104, 64, 44, 255] as Rgba,
  rifleBody: [86, 116, 188, 255] as Rgba,
  rifleBodyDark: [60, 78, 140, 255] as Rgba,
  rifleGear: [210, 186, 104, 255] as Rgba,
  white: [255, 255, 255, 255] as Rgba,
  black: [20, 20, 26, 255] as Rgba,
  redText: [255, 104, 86, 255] as Rgba,
  yellowText: [252, 218, 24, 255] as Rgba,
  greenText: [128, 232, 128, 255] as Rgba,
  shadow: [12, 12, 14, 255] as Rgba,
} satisfies Record<string, Rgba>;

export type Palette = typeof C;

// ── 1x pixel sprites (char maps, scaled at draw time) ──────────────────────

/** Bill — facing right. 8 wide × 12 tall incl. gun. */
export const PLAYER_SPRITES = [
  // frame 0: standing / run A
  [
    ".H......",
    ".HR.....",
    ".SSR....",
    ".SSS....",
    ".BBBB...",
    ".BBBGG..",
    "BBBB.SG.",
    ".BBBB...",
    ".LL.LL..",
    ".L...L..",
    ".B...B..",
    ".B...B..",
  ],
  // frame 1: run B — legs split
  [
    ".H......",
    ".HR.....",
    ".SSR....",
    ".SSS....",
    ".BBBB...",
    ".BBBGG..",
    "BBBB.SG.",
    ".BBBB...",
    ".LL.L...",
    ".L..LL..",
    ".B...B..",
  ],
  // frame 2: jump — legs tucked
  [
    ".H......",
    ".HR.....",
    ".SSR....",
    ".SSS....",
    ".BBBB...",
    ".BBBGG..",
    "BBBB.SG.",
    ".BBBB...",
    ".LL...L.",
    ".L.....L",
    ".LL...LL",
  ],
] as const;

export const PLAYER_COLORS: Record<string, Rgba> = {
  H: C.playerHair,
  R: C.playerBandana,
  S: C.playerSkin,
  B: C.playerBody,
  G: C.gun,
  L: C.playerBelt,
};

/** Grunt soldier. 6×8 ×2 frames. */
export const GRUNT_SPRITES = [
  [".HHHH.", "HHHHHH", ".SSS..", "SSSS..", ".BBB..", "BBBB..", ".L.L..", ".L.L.."],
  [".HHHH.", "HHHHHH", ".SSS..", "SSSS..", ".BBB..", "BBBB..", ".L..L.", ".L...L"],
] as const;

export const GRUNT_COLORS = {
  H: C.gruntHelmet,
  S: C.gruntSkin,
  B: C.gruntBody,
  L: C.gruntHelmetDark,
};

/** Rifleman 7×9 ×2 frames. */
export const RIFLE_SPRITES = [
  [
    ".RRRR..",
    "RRRRRR.",
    ".GGG...",
    ".GGG...",
    "BBBB.B.",
    "BBBBG..",
    ".BBBG..",
    ".B..B..",
    ".B..B..",
  ],
  [
    ".RRRR..",
    "RRRRRR.",
    ".GGG...",
    ".GGG...",
    "BBBB.B.",
    "BBBBG..",
    ".BBBG..",
    ".B...B.",
    ".B....B",
  ],
] as const;

export const RIFLE_COLORS = {
  R: C.rifleBody,
  G: C.rifleGear,
  B: C.rifleBodyDark,
};

// ── 5×7 pixel font ─────────────────────────────────────────────────────────

const FONT_GLYPHS: Record<string, string[]> = {
  "0": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["01110", "10001", "00001", "00110", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  "·": ["00000", "00110", "00110", "00000", "00000", "00000", "00000"],
};

export const FONT_CHAR_W = 5;
export const FONT_CHAR_H = 7;

// ── raster primitives ──────────────────────────────────────────────────────

export function setPx(buf: Uint8Array, w: number, h: number, x: number, y: number, c: Rgba): void {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= w || iy >= h) return;
  const i = (iy * w + ix) * 4;
  const a = c[3];
  if (a === 255) {
    buf[i] = c[0];
    buf[i + 1] = c[1];
    buf[i + 2] = c[2];
    buf[i + 3] = 255;
  } else if (a > 0) {
    const af = a / 255;
    const ia = 1 - af;
    buf[i] = Math.round(buf[i] * ia + c[0] * af);
    buf[i + 1] = Math.round(buf[i + 1] * ia + c[1] * af);
    buf[i + 2] = Math.round(buf[i + 2] * ia + c[2] * af);
    buf[i + 3] = 255;
  }
}

export function fillRect(
  buf: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
  rw: number,
  rh: number,
  c: Rgba,
): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(w, Math.ceil(x + rw));
  const y1 = Math.min(h, Math.ceil(y + rh));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) setPx(buf, w, h, px, py, c);
  }
}

export function fillCircle(
  buf: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  r: number,
  c: Rgba,
): void {
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(w, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(h, Math.ceil(cy + r + 1));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy <= r2) setPx(buf, w, h, px, py, c);
    }
  }
}

/**
 * Draw a char-map sprite. `scale` multiplies each map cell; `flipX` mirrors
 * around the sprite center. Anchored at top-left.
 */
export function drawSprite(
  buf: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
  sprite: readonly string[],
  palette: Record<string, Rgba>,
  scale: number,
  flipX = false,
): void {
  const sw = sprite[0]!.length;
  const sh = sprite.length;
  for (let sy = 0; sy < sh; sy++) {
    const row = sprite[sy]!;
    for (let sx = 0; sx < sw; sx++) {
      const ch = row[sx]!;
      if (ch === "." || ch === " ") continue;
      const col = palette[ch];
      if (!col) continue;
      const dx = flipX ? sw - 1 - sx : sx;
      fillRect(buf, w, h, x + dx * scale, y + sy * scale, scale, scale, col);
    }
  }
}

export function drawChar(
  buf: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
  ch: string,
  scale: number,
  c: Rgba,
): void {
  const glyph = FONT_GLYPHS[ch] ?? FONT_GLYPHS[" "]!;
  for (let gy = 0; gy < FONT_CHAR_H; gy++) {
    const row = glyph[gy]!;
    for (let gx = 0; gx < FONT_CHAR_W; gx++) {
      if (row[gx] === "1") fillRect(buf, w, h, x + gx * scale, y + gy * scale, scale, scale, c);
    }
  }
}

export function textWidth(text: string, scale: number): number {
  return text.length * (FONT_CHAR_W * scale + scale);
}

/** Draw centered text with a 1px-scale shadow behind. */
export function drawTextCentered(
  buf: Uint8Array,
  w: number,
  h: number,
  text: string,
  cx: number,
  y: number,
  scale: number,
  c: Rgba,
  shadow = C.shadow,
): void {
  const tw = textWidth(text, scale);
  const startX = Math.round(cx - tw / 2);
  let x = startX + scale;
  for (const ch of text) {
    drawChar(buf, w, h, x, y + scale, ch, scale, shadow);
    x += FONT_CHAR_W * scale + scale;
  }
  x = startX;
  for (const ch of text) {
    drawChar(buf, w, h, x, y, ch, scale, c);
    x += FONT_CHAR_W * scale + scale;
  }
}

export function drawTextLeft(
  buf: Uint8Array,
  w: number,
  h: number,
  text: string,
  x: number,
  y: number,
  scale: number,
  c: Rgba,
  shadow = C.shadow,
): void {
  let sx = x + scale;
  for (const ch of text) {
    drawChar(buf, w, h, sx, y + scale, ch, scale, shadow);
    sx += FONT_CHAR_W * scale + scale;
  }
  sx = x;
  for (const ch of text) {
    drawChar(buf, w, h, sx, y, ch, scale, c);
    sx += FONT_CHAR_W * scale + scale;
  }
}

// ── PNG encoder ────────────────────────────────────────────────────────────

const PNG_SIG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

let crcTab: Uint32Array | undefined;
function crcTable(): Uint32Array {
  if (crcTab) return crcTab;
  const t = new Uint32Array(256);
  for (let v = 0; v < 256; v++) {
    let c = v;
    for (let b = 0; b < 8; b++) c = c & 1 ? 3988292384 ^ (c >>> 1) : c >>> 1;
    t[v] = c >>> 0;
  }
  crcTab = t;
  return t;
}

function crc32(type: string, data: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  const typeBytes = new TextEncoder().encode(type);
  for (const b of [typeBytes, data]) {
    for (const byte of b) c = t[(c ^ byte) & 255] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function w32(buf: Uint8Array, off: number, v: number): void {
  buf[off] = (v >>> 24) & 255;
  buf[off + 1] = (v >>> 16) & 255;
  buf[off + 2] = (v >>> 8) & 255;
  buf[off + 3] = v & 255;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const c = new Uint8Array(12 + data.byteLength);
  w32(c, 0, data.byteLength);
  c.set(typeBytes, 4);
  c.set(data, 8);
  w32(c, 8 + data.byteLength, crc32(type, data));
  return c;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** Encode an RGBA (4 bytes/pixel, straight alpha) buffer as PNG. */
export function encodeRgbaPng(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const pw = Math.floor(w);
  const ph = Math.floor(h);
  if (pw <= 0 || ph <= 0) throw new Error("PNG dimensions must be positive");
  const rowBytes = pw * 4;
  if (rgba.byteLength !== rowBytes * ph) throw new Error("RGBA byte length mismatch");
  const ihdr = new Uint8Array(13);
  w32(ihdr, 0, pw);
  w32(ihdr, 4, ph);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const scanlines = new Uint8Array((rowBytes + 1) * ph);
  for (let y = 0; y < ph; y++) {
    const t = y * (rowBytes + 1);
    scanlines[t] = 0; // filter: none
    scanlines.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), t + 1);
  }
  return concatBytes([
    PNG_SIG,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(deflateSync(scanlines, { level: 1 }))),
    pngChunk("IEND", new Uint8Array()),
  ]);
}
