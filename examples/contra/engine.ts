/**
 * Terminal Contra (魂斗罗) — pure game engine.
 *
 * Framework-free and deterministic: no Vue, no timers, no Date.now(). The Vue
 * component (ContraGame.ts) drives `step()` on a fixed tick and renders the
 * latest `snapshot()`. The CLI runner (contra-terminal.ts) drives the same
 * engine directly in smoke mode for assertable, deterministic tests.
 *
 * Everything is measured in terminal cells; positions are floats and get
 * snapped to integer cells when rendered. All timings are in milliseconds and
 * accumulated engine-time (`now`), so a fixed script of `pressKey`/`step`
 * calls always produces the same outcome for a given seed.
 */

export type GamePhase = "playing" | "paused" | "gameover";

export type EnemyKind = "grunt" | "rifle";

export interface ContraGameOptions {
  /** Playfield width in cells (content area of the bordered box). */
  cols: number;
  /** Playfield height in cells (content area of the bordered box). */
  rows: number;
  /** Fixed seed for deterministic runs (smoke tests); random when omitted. */
  seed?: number;
  /** Movement/bullet speed multiplier (smoke tests shorten runs with this). */
  speedScale?: number;
  /** Delay before the first enemy spawn, in ms. */
  firstSpawnMs?: number;
}

export interface PlayerState {
  /** Float x position; snapped to cells when rendered. */
  x: number;
  /** Float y position; snapped to cells when rendered. */
  y: number;
  vy: number;
  facing: 1 | -1;
  onGround: boolean;
  alive: boolean;
  /** Remaining invincibility after being hit, ms. */
  invincibleMs: number;
}

export interface EnemyState {
  id: number;
  kind: EnemyKind;
  x: number;
  y: number;
  vx: number;
  hp: number;
  /** Riflemen only: time until the next aimed shot. */
  fireTimerMs: number;
  /** Short white-flash after being shot. */
  hitFlashMs: number;
}

export interface BulletState {
  id: number;
  x: number;
  y: number;
  vx: number;
  from: "player" | "enemy";
}

export interface ExplosionState {
  id: number;
  x: number;
  y: number;
  t: number;
}

export interface PlatformState {
  x: number;
  y: number;
  w: number;
}

export interface ContraSnapshot {
  phase: GamePhase;
  now: number;
  cols: number;
  rows: number;
  groundY: number;
  score: number;
  hiScore: number;
  lives: number;
  stage: number;
  kills: number;
  /** Walk-cycle phase accumulator (ms), for sprite animation. */
  moveAnim: number;
  player: PlayerState;
  platforms: readonly PlatformState[];
  enemies: readonly EnemyState[];
  playerBullets: readonly BulletState[];
  enemyBullets: readonly BulletState[];
  explosions: readonly ExplosionState[];
}

/** Per-tick simulation step used by the interactive loop (30 fps). */
export const GAME_TICK_MS = 1000 / 30;

const WALK_SPEED = 11; // cells / s
const GRAVITY = 24; // cells / s^2
const JUMP_VY = 21.5; // cells / s (apex ≈ 9.6 cells)
const MAX_FALL = 13; // cells / s
const BULLET_SPEED = 16; // cells / s
const ENEMY_BULLET_SPEED = 7; // cells / s
const FIRE_COOLDOWN_MS = 240;
const AUTO_FIRE_WINDOW_MS = 340;
const JUMP_REPEAT_GUARD_MS = 220;
const COYOTE_MS = 90;
const MOVE_HOLD_MS = 260; // walking continues while key repeats keep arriving
const INVINCIBLE_MS = 2000;
const BLINK_PERIOD_MS = 90;
const EXPLOSION_LIFE_MS = 240;
const HIT_FLASH_MS = 120;
const SPAWN_BASE_MS = 2100;
const SPAWN_MIN_MS = 650;
const SPAWN_STEP_MS = 180;
const START_LIVES = 3;
const KILLS_PER_STAGE = 8;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export class ContraEngine {
  readonly options: ContraGameOptions & {
    cols: number;
    rows: number;
    seed: number;
    speedScale: number;
    firstSpawnMs: number;
  };

  private phase: GamePhase = "playing";
  private nowMs = 0;
  private rng: () => number;
  private speedScale: number;
  private firstSpawnMs: number;

  private cols: number;
  private rows: number;
  private groundY = 0;

  private player: PlayerState;
  private lastGroundedAt = -Infinity;
  private lastJumpAt = -Infinity;
  private moveDir: -1 | 0 | 1 = 0;
  private movePressedAt = -Infinity;
  private autoFireUntil = 0;
  private fireCooldownMs = 0;
  /** Walk-cycle phase accumulator (ms) for animation, advanced while the
   *  player is actually moving on the ground. */
  private moveAnimMs = 0;

  private score = 0;
  private hiScore = 0;
  private lives = START_LIVES;
  private stage = 1;
  private kills = 0;

  private platforms: PlatformState[] = [];
  private enemies: EnemyState[] = [];
  private playerBullets: BulletState[] = [];
  private enemyBullets: BulletState[] = [];
  private explosions: ExplosionState[] = [];
  private spawnTimerMs = SPAWN_BASE_MS;
  private nextId = 1;

  constructor(options: ContraGameOptions) {
    const cols = Math.max(24, Math.floor(options.cols));
    const rows = Math.max(10, Math.floor(options.rows));
    const seed = options.seed ?? (Math.random() * 0xffffffff) >>> 0;
    const speedScale = options.speedScale ?? 1;
    const firstSpawnMs = options.firstSpawnMs ?? SPAWN_BASE_MS;
    this.options = { cols, rows, seed, speedScale, firstSpawnMs };
    this.cols = cols;
    this.rows = rows;
    this.speedScale = speedScale;
    this.firstSpawnMs = firstSpawnMs;
    this.rng = mulberry32(seed);
    this.player = this.freshPlayer();
    this.rebuildField();
    this.reset();
  }

  private freshPlayer(): PlayerState {
    return {
      x: 3,
      y: 0,
      vy: 0,
      facing: 1,
      onGround: true,
      alive: true,
      invincibleMs: 0,
    };
  }

  private rebuildField(): void {
    this.groundY = Math.max(3, this.rows - 2);
    const out: PlatformState[] = [];
    const ground = this.groundY;
    const w = this.cols;
    if (ground >= 6) {
      out.push({ x: clamp(Math.floor(w * 0.15), 4, Math.max(4, w - 10)), y: ground - 5, w: 8 });
    }
    if (ground >= 10) {
      out.push({ x: clamp(Math.floor(w * 0.5), 6, Math.max(6, w - 14)), y: ground - 9, w: 11 });
    }
    this.platforms = out.filter((p) => p.y >= 2 && p.x + p.w <= w);
  }

  reset(): void {
    this.player = this.freshPlayer();
    this.player.y = this.groundY - 1;
    this.lastGroundedAt = -Infinity;
    this.lastJumpAt = -Infinity;
    this.moveDir = 0;
    this.autoFireUntil = 0;
    this.fireCooldownMs = 0;
    this.nowMs = 0;
    this.score = 0;
    this.lives = START_LIVES;
    this.stage = 1;
    this.kills = 0;
    this.enemies = [];
    this.playerBullets = [];
    this.enemyBullets = [];
    this.explosions = [];
    this.spawnTimerMs = this.firstSpawnMs;
    this.phase = "playing";
    this.rebuildField();
  }

  /** Recompute playfield geometry after a terminal resize (mid-game safe). */
  resize(cols: number, rows: number): void {
    const nextCols = Math.max(24, Math.floor(cols));
    const nextRows = Math.max(10, Math.floor(rows));
    if (nextCols === this.cols && nextRows === this.rows) return;
    this.cols = nextCols;
    this.rows = nextRows;
    this.rebuildField();
    const p = this.player;
    p.x = clamp(p.x, 0, this.cols - 2);
    p.y = clamp(p.y, 0, this.groundY - 1);
    if (p.y + 1 > this.groundY) p.y = this.groundY - 1;
    for (const e of this.enemies) {
      e.x = clamp(e.x, 0, this.cols - 1);
      e.y = this.groundY - 1;
    }
  }

  /** Feed a keyboard key, e.g. "ArrowRight", "j", " ", "p", "Enter". */
  pressKey(key: string): void {
    const raw = String(key ?? "");
    let k = raw.trim().toLowerCase();
    if (raw === " " || k === "space") k = " ";
    if (this.phase === "paused") {
      if (k === "p" || k === "enter") this.phase = "playing";
      return;
    }
    if (this.phase === "gameover") {
      if (k === "enter" || k === " ") this.reset();
      return;
    }
    if (k === "arrowleft" || k === "a") this.startMove(-1);
    else if (k === "arrowright" || k === "d") this.startMove(1);
    else if (k === "arrowup" || k === "w" || k === " ") this.tryJump();
    else if (k === "j" || k === "z") {
      this.fire();
      this.autoFireUntil = this.nowMs + AUTO_FIRE_WINDOW_MS;
    } else if (k === "p") this.phase = "paused";
  }

  step(dtMs: number): void {
    if (!Number.isFinite(dtMs) || dtMs <= 0) return;
    this.nowMs += dtMs;
    this.advanceExplosions(dtMs);
    if (this.player.invincibleMs > 0) {
      this.player.invincibleMs = Math.max(0, this.player.invincibleMs - dtMs);
    }
    if (this.phase !== "playing") return;
    const dt = Math.min(dtMs, 50) / 1000;
    const scale = this.speedScale;

    // Keep firing while the shoot key is held: terminal key-repeat keeps
    // refreshing the auto-fire window; the cooldown paces the shots.
    this.fireCooldownMs -= dtMs;
    if (this.autoFireUntil > 0 && this.nowMs < this.autoFireUntil && this.fireCooldownMs <= 0) {
      this.fire();
    }

    this.stepPlayer(dt);
    this.stepSpawn(dtMs);
    this.stepEnemies(dt);
    this.stepBullets(dt);
    this.stepContact();
    this.stage = 1 + Math.floor(this.kills / KILLS_PER_STAGE);
  }

  /** Current game phase (read-only accessor for UI status lines). */
  getPhase(): GamePhase {
    return this.phase;
  }

  snapshot(): ContraSnapshot {
    const e = this.enemies;
    return {
      phase: this.phase,
      now: this.nowMs,
      cols: this.cols,
      rows: this.rows,
      groundY: this.groundY,
      score: this.score,
      hiScore: this.hiScore,
      lives: this.lives,
      stage: this.stage,
      kills: this.kills,
      moveAnim: this.moveAnimMs,
      player: { ...this.player },
      platforms: this.platforms.map((p) => ({ ...p })),
      enemies: e.map((enemy) => ({ ...enemy })),
      playerBullets: this.playerBullets.map((b) => ({ ...b })),
      enemyBullets: this.enemyBullets.map((b) => ({ ...b })),
      explosions: this.explosions.map((x) => ({ ...x })),
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private startMove(dir: -1 | 1): void {
    this.moveDir = dir;
    this.movePressedAt = this.nowMs;
    this.player.facing = dir;
  }

  private tryJump(): void {
    if (this.nowMs - this.lastJumpAt < JUMP_REPEAT_GUARD_MS) return;
    const grounded = this.player.onGround || this.nowMs - this.lastGroundedAt < COYOTE_MS;
    if (!grounded) return;
    this.player.vy = -JUMP_VY;
    this.player.onGround = false;
    this.lastGroundedAt = -Infinity;
    this.lastJumpAt = this.nowMs;
  }

  private fire(): void {
    if (!this.player.alive) return;
    if (this.fireCooldownMs > 0) return;
    this.fireCooldownMs = FIRE_COOLDOWN_MS;
    const p = this.player;
    this.playerBullets.push({
      id: this.nextId++,
      x: p.facing > 0 ? Math.floor(p.x) + 2 : Math.floor(p.x) - 1,
      y: Math.round(p.y),
      vx: p.facing * BULLET_SPEED * this.speedScale,
      from: "player",
    });
  }

  private stepPlayer(dt: number): void {
    const p = this.player;
    if (!p.alive) return;

    // Walk while the key is held (repeats refresh the window); a short tap
    // takes a few steps and then stops.
    if (this.moveDir !== 0) {
      if (this.nowMs - this.movePressedAt < MOVE_HOLD_MS) {
        p.x = clamp(p.x + this.moveDir * WALK_SPEED * this.speedScale * dt, 0, this.cols - 2);
        this.moveAnimMs += dt * 1000;
      } else this.moveDir = 0;
    }

    const prevBottom = p.y + 1;
    p.vy = Math.min(p.vy + GRAVITY * dt, MAX_FALL);
    p.y += p.vy * dt;
    const bottom = p.y + 1;
    let landed = false;

    // One-way platforms: only land while falling and when the previous bottom
    // was above the platform top; jump through from below.
    for (const plat of this.platforms) {
      if (p.vy > 0 && prevBottom <= plat.y + 0.001 && bottom >= plat.y) {
        const px = Math.floor(p.x);
        if (px > plat.x + plat.w - 1 || px + 1 < plat.x) continue;
        p.y = plat.y - 1;
        p.vy = 0;
        landed = true;
        break;
      }
    }
    if (!landed && bottom >= this.groundY) {
      p.y = this.groundY - 1;
      p.vy = 0;
      landed = true;
    }
    p.onGround = landed;
    if (landed) this.lastGroundedAt = this.nowMs;
  }

  private stepSpawn(dtMs: number): void {
    this.spawnTimerMs -= dtMs;
    if (this.spawnTimerMs > 0) return;
    this.spawnEnemy();
    const min = Math.max(SPAWN_MIN_MS, SPAWN_BASE_MS - (this.stage - 1) * SPAWN_STEP_MS);
    this.spawnTimerMs = min * (0.9 + this.rng() * 0.3);
  }

  private spawnEnemy(): void {
    if (this.cols <= 8) return;
    const fromLeft = this.rng() < 0.18;
    const x = fromLeft ? 0 : this.cols - 1;
    const dir = fromLeft ? 1 : -1;
    const rifleChance = this.stage >= 3 ? 0.45 : this.stage === 2 ? 0.3 : 0.12;
    const kind: EnemyKind = this.rng() < rifleChance ? "rifle" : "grunt";
    const speed =
      kind === "grunt" ? 3.2 + this.stage * 0.35 + this.rng() * 1.3 : 2.8 + this.stage * 0.2;
    this.enemies.push({
      id: this.nextId++,
      kind,
      x,
      y: this.groundY - 1,
      vx: dir * speed * this.speedScale,
      hp: kind === "grunt" ? 1 : 2,
      fireTimerMs: 700 + this.rng() * 800,
      hitFlashMs: 0,
    });
  }

  private stepEnemies(dt: number): void {
    const p = this.player;
    for (const e of this.enemies) {
      if (e.hitFlashMs > 0) e.hitFlashMs = Math.max(0, e.hitFlashMs - dt * 1000);
      if (e.kind === "rifle") {
        const stopX = this.cols * 0.58;
        if ((e.vx > 0 && e.x >= stopX) || (e.vx < 0 && e.x <= stopX)) {
          e.x = clamp(e.x, Math.min(stopX, 0), Math.max(stopX, this.cols - 1));
          e.vx = 0;
          e.fireTimerMs -= dt * 1000;
          if (e.fireTimerMs <= 0 && p.alive) {
            const dir = p.x >= e.x ? 1 : -1;
            this.enemyBullets.push({
              id: this.nextId++,
              x: e.x + dir,
              y: e.y,
              vx: dir * ENEMY_BULLET_SPEED * this.speedScale,
              from: "enemy",
            });
            e.fireTimerMs = 1100 + this.rng() * 900;
          }
        } else e.x += e.vx * dt;
      } else e.x += e.vx * dt;
    }
    this.enemies = this.enemies.filter((e) => e.x > -1 && e.x < this.cols + 1);
  }

  private stepBullets(dt: number): void {
    const p = this.player;
    const px0 = Math.floor(p.x);
    const px1 = px0 + 1;
    const py = Math.round(p.y);

    // Player bullets: sweep the travelled segment so fast bullets (and smoke's
    // 3x speed scale) can never skip past a 1-cell enemy.
    const survivors: BulletState[] = [];
    for (const b of this.playerBullets) {
      const fromX = b.x;
      b.x += b.vx * dt;
      if (b.x < -1 || b.x >= this.cols + 1) continue;
      const lo = Math.min(fromX, b.x);
      const hi = Math.max(fromX, b.x);
      const y = Math.round(b.y);
      const hitEnemy = this.enemies.find((e) => {
        if (Math.round(e.y) !== y) return false;
        return hi >= e.x && lo <= e.x + 1;
      });
      if (hitEnemy) {
        hitEnemy.hp -= 1;
        hitEnemy.hitFlashMs = HIT_FLASH_MS;
        if (hitEnemy.hp <= 0) this.killEnemy(hitEnemy);
        continue;
      }
      survivors.push(b);
    }
    this.playerBullets = survivors;

    // Enemy bullets: same segment sweep against the 2-cell player body.
    const enemySurvivors: BulletState[] = [];
    for (const b of this.enemyBullets) {
      const fromX = b.x;
      b.x += b.vx * dt;
      if (b.x < -1 || b.x >= this.cols + 1) continue;
      const lo = Math.min(fromX, b.x);
      const hi = Math.max(fromX, b.x);
      const canHit =
        p.alive && p.invincibleMs <= 0 && Math.round(b.y) === py && hi >= px0 && lo <= px1 + 1;
      if (canHit) {
        this.hitPlayer();
        continue;
      }
      enemySurvivors.push(b);
    }
    this.enemyBullets = enemySurvivors;
  }

  private stepContact(): void {
    const p = this.player;
    if (!p.alive || p.invincibleMs > 0) return;
    const px = Math.floor(p.x);
    const py = Math.round(p.y);
    for (const e of this.enemies) {
      if (e.x - 1 >= px + 2 || e.x + 1 <= px) continue;
      if (Math.floor(e.y) === py) {
        this.hitPlayer();
        return;
      }
    }
  }

  private killEnemy(e: EnemyState): void {
    this.score += e.kind === "grunt" ? 100 + (this.stage - 1) * 25 : 250 + (this.stage - 1) * 50;
    this.kills += 1;
    this.explosions.push({ id: this.nextId++, x: Math.floor(e.x), y: e.y, t: 0 });
    const idx = this.enemies.indexOf(e);
    if (idx >= 0) this.enemies.splice(idx, 1);
  }

  private hitPlayer(): void {
    if (this.player.invincibleMs > 0) return;
    this.lives -= 1;
    if (this.lives <= 0) {
      this.lives = 0;
      this.player.alive = false;
      this.phase = "gameover";
      this.hiScore = Math.max(this.hiScore, this.score);
      return;
    }
    this.player.invincibleMs = INVINCIBLE_MS;
    this.explosions.push({
      id: this.nextId++,
      x: Math.floor(this.player.x),
      y: Math.round(this.player.y),
      t: 0,
    });
  }

  private advanceExplosions(dtMs: number): void {
    if (!this.explosions.length) return;
    for (const ex of this.explosions) ex.t += dtMs;
    this.explosions = this.explosions.filter((ex) => ex.t < EXPLOSION_LIFE_MS);
  }
}
