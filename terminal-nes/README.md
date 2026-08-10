# 🎮 terminal-nes

**Real NES emulator in your terminal.** A single command starts a genuine NES
emulator (jsnes core) streaming pixel-perfect 256×224 frames into your terminal
via kitty/iTerm2/sixel graphics — no canvas, no browser, no X server.

Comes with a free-to-distribute homebrew ROM (`assets/falling.nes`, MIT) so it
works out of the box, and supports your own legally-owned ROMs.

## Install & run

```bash
npm i -g terminal-nes
terminal-nes
```

Or run directly without installing:

```bash
npx terminal-nes
```

> Requires a graphics-protocol terminal: **Kitty, iTerm2, WezTerm, Ghostty** or
> any **Sixel** terminal. Otherwise a friendly hint is printed.

## Controls

Bundled Falling game:

| Key                    | Action                      |
| ---------------------- | --------------------------- |
| `←` / `→` or `A` / `D` | Move left/right             |
| `↑` / `↓`              | Select mode before starting |
| `Enter`                | Start                       |
| `P`                    | Open menu                   |
| `Q` / `Ctrl+C`         | Quit                        |

The pause menu provides resume, share, restart, and quit actions. Generic ROMs
still receive the complete NES D-pad plus `Z/J` = B, `X/K` = A, `Enter` = Start,
and `Shift` = Select.

## Play your own (legally owned) ROM

```bash
mkdir -p ~/.config/terminal-nes/roms
cp /path/to/your/rom.nes ~/.config/terminal-nes/roms/
VUE_TUI_NES_ROMS_DIR=~/.config/terminal-nes/roms VUE_TUI_NES_RANDOM=1 terminal-nes
```

Or point to a single ROM directly:

```bash
VUE_TUI_NES_ROM=/path/to/contra.nes terminal-nes
```

> Original NES Contra uses **Mapper 2**, which is fully supported by the
> bundled jsnes core — your legal ROM drops right in.

© Copyright reminder: the package ships **no commercial game data**. Only run
ROMs you legally own (own-cartridge dumps / officially licensed files).

## Share to X + leaderboard

Open the menu with `P`, then press `2`:

1. Screenshot saved as PNG (`.nes-shares/`)
2. Image copied to the system clipboard (macOS/Linux)
3. Browser opens the X composer with a caption pre-filled:
   vue-tui repo link + `#vueTui #terminalUI #retroGaming`
4. Local leaderboard tracked at `~/.vue-tui-nes/leaderboard.json`

Customize your player name: `VUE_TUI_NES_PLAYER=my-name terminal-nes`

## Graphics quality

- NTSC overscan cropped (real visible 256×224 picture)
- Automatic integer upscaling (1×/2×) when the terminal is large enough —
  nearest-neighbour, pixel crisp
- Falls back to exact-fit on small terminals

## Scripts (repo)

```bash
pnpm run build             # tsdown → dist/cli.js + dist/index.js
pnpm run typecheck
pnpm run smoke             # headless emulation + PNG validation
pnpm run check:rom         # verify a ROM loads on the bundled core
pnpm run check:input       # no-keyup input direction regression
pnpm run check:share       # share pipeline (screenshot/caption/leaderboard)
pnpm run check:share-browser  # X intent URL + clipboard image (no browser open)
pnpm run pack:local        # local tarball
```

## How it works

- `src/nes-video-game.ts` — jsnes → overscan crop → RGBA → PNG → TVideo
- `src/run.ts` — CLI runner: ROM resolution, input mapping, share handling
- `src/share.ts` — screenshot, X post, local leaderboard
- `src/png.ts` — pure Node zlib PNG encoder + nearest resize
- `src/vendor/jsnes/` — jsnes core (Apache-2.0, see NOTICE)
- `assets/falling.nes` — MIT-licensed homebrew game (LICENSE included)

## License

MIT (this package). Vendored code: jsnes (Apache-2.0), Falling (MIT).
