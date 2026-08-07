import { afterEach, describe, expect, it, vi } from "vitest";
import { createStdoutRenderer } from "../src/cli.js";
import {
  clearMermaidImageCache,
  getCachedMermaidImage,
  getMermaidImage,
  isMermaidImageRendererReady,
  setMermaidImageRasterizer,
  subscribeMermaidImage,
  TMermaidImage,
  type TuiMermaidImageRasterizer,
} from "../src/mermaid.js";
import { h, mountTerminal, nextTick } from "./ui-regressions-support.js";

type MountedTerminal = Awaited<ReturnType<typeof mountTerminal>>;

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const SAMPLE_SOURCE = "graph LR\n  A --> B";

function rowText(mounted: MountedTerminal, y: number): string {
  return mounted.terminal
    .getRow(y)
    .map((cell) => cell.ch)
    .join("")
    .trimEnd();
}

function clickCell(mounted: MountedTerminal, cellX: number, cellY: number): void {
  mounted.container()?.dispatchEvent(
    new MouseEvent("click", {
      clientX: cellX * 10 + 1,
      clientY: cellY * 20 + 1,
      bubbles: true,
    }),
  );
}

function setDeterministicMetrics(mounted: MountedTerminal, cols: number, rows: number): void {
  const container = mounted.container();
  const events = mounted.events();
  if (!container || !events) throw new Error("expected mounted terminal events");
  const cellWidth = 10;
  const cellHeight = 20;
  events.setMetrics({ cellWidth, cellHeight });
  container.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      x: 0,
      y: 0,
      width: cols * cellWidth,
      height: rows * cellHeight,
      right: cols * cellWidth,
      bottom: rows * cellHeight,
      toJSON() {},
    }) as any;
}

async function settle(mounted: MountedTerminal): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    mounted.scheduler()?.flushNow();
  }
}

async function withEnv<T>(
  updates: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function installNavigatorClipboard(writeText: ReturnType<typeof vi.fn>): () => void {
  const originalClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { readText: vi.fn().mockResolvedValue(""), writeText },
    configurable: true,
  });
  return () => {
    if (originalClipboard) {
      Object.defineProperty(globalThis.navigator, "clipboard", originalClipboard);
    } else {
      delete (globalThis.navigator as any).clipboard;
    }
  };
}

afterEach(() => {
  setMermaidImageRasterizer(null);
  clearMermaidImageCache();
});

describe("mermaid-image rasterizer", () => {
  it("rasterizes through a custom rasterizer and caches by source + options", async () => {
    const rasterizer = vi.fn<TuiMermaidImageRasterizer>(async () => ({
      base64: TINY_PNG_BASE64,
      widthCells: 6,
      heightCells: 3,
      naturalWidth: 48,
      naturalHeight: 24,
    }));
    setMermaidImageRasterizer(rasterizer);
    expect(isMermaidImageRendererReady()).toBe(true);

    const first = await getMermaidImage(SAMPLE_SOURCE);
    const second = await getMermaidImage(SAMPLE_SOURCE);

    expect(rasterizer).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first?.base64).toBe(TINY_PNG_BASE64);
    expect(getCachedMermaidImage(SAMPLE_SOURCE)).toEqual(first);

    // A different cell metric produces a different cache entry.
    await getMermaidImage(SAMPLE_SOURCE, { scale: 3 });
    expect(rasterizer).toHaveBeenCalledTimes(2);

    clearMermaidImageCache();
    expect(getCachedMermaidImage(SAMPLE_SOURCE)).toBeNull();
  });

  it("passes normalized image options to the rasterizer", async () => {
    const rasterizer = vi.fn<TuiMermaidImageRasterizer>(async () => ({
      base64: TINY_PNG_BASE64,
      widthCells: 1,
      heightCells: 1,
    }));
    setMermaidImageRasterizer(rasterizer);

    await getMermaidImage(SAMPLE_SOURCE, { cellWidthPx: 7, fg: "#ffffff", maxWidthCells: 40 });

    expect(rasterizer).toHaveBeenCalledTimes(1);
    expect(rasterizer.mock.calls[0]![0]).toBe(SAMPLE_SOURCE);
    expect(rasterizer.mock.calls[0]![1]).toMatchObject({
      cellWidthPx: 7,
      cellHeightPx: 16,
      scale: 2,
      fg: "#ffffff",
      maxWidthCells: 40,
      maxHeightCells: 0,
      padding: 40,
    });
  });

  it("notifies subscribers when a new image completes", async () => {
    const rasterizer = vi.fn<TuiMermaidImageRasterizer>(async () => ({
      base64: TINY_PNG_BASE64,
      widthCells: 4,
      heightCells: 2,
    }));
    setMermaidImageRasterizer(rasterizer);

    const listener = vi.fn();
    const unsubscribe = subscribeMermaidImage(listener);
    try {
      await getMermaidImage(SAMPLE_SOURCE);
      expect(listener).toHaveBeenCalledTimes(1);

      // Cache hit does not notify again.
      await getMermaidImage(SAMPLE_SOURCE);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it("remembers failed sources and returns null without re-rasterizing", async () => {
    const rasterizer = vi.fn<TuiMermaidImageRasterizer>(async () => null);
    setMermaidImageRasterizer(rasterizer);

    expect(await getMermaidImage(SAMPLE_SOURCE)).toBeNull();
    expect(await getMermaidImage(SAMPLE_SOURCE)).toBeNull();
    expect(rasterizer).toHaveBeenCalledTimes(1);
  });
});

describe("TMermaidImage", () => {
  it("shows the raw source inside the box when the terminal has no graphics protocol", async () => {
    const mounted = await mountTerminal(
      () =>
        h(TMermaidImage, {
          x: 0,
          y: 0,
          w: 24,
          content: SAMPLE_SOURCE,
        }),
      32,
      6,
    );

    try {
      await settle(mounted);

      expect(rowText(mounted, 0)).toContain("mermaid");
      expect(rowText(mounted, 0)).toContain("copy");
      expect(rowText(mounted, 1)).toContain("graph LR");
      expect(rowText(mounted, 2)).toContain("A --> B");
      expect(rowText(mounted, 3)).toBe("└──────────────────────┘");
    } finally {
      mounted.unmount();
    }
  });

  it("emits a Kitty graphics frame when the terminal supports graphics", async () => {
    await withEnv(
      {
        KITTY_WINDOW_ID: "vue-tui-test",
        TERM: "xterm-kitty",
        TERM_PROGRAM: "kitty",
        CI: undefined,
        TMUX: undefined,
        VUE_TUI_GRAPHICS_FORCE: "1",
      },
      async () => {
        setMermaidImageRasterizer(async () => ({
          base64: TINY_PNG_BASE64,
          widthCells: 10,
          heightCells: 3,
          naturalWidth: 80,
          naturalHeight: 24,
        }));

        const mounted = await mountTerminal(
          () =>
            h(TMermaidImage, {
              x: 0,
              y: 0,
              w: 20,
              content: SAMPLE_SOURCE,
            }),
          32,
          8,
        );

        let stdout = "";
        const renderer = createStdoutRenderer(mounted.terminal, {
          output: {
            isTTY: true,
            write(chunk: string) {
              stdout += chunk;
            },
          },
          clear: false,
          hideCursor: false,
          altScreen: false,
          terminalGraphics: { protocol: "kitty", force: true },
        });

        try {
          await settle(mounted);
          (renderer as any).render(undefined, true);

          // Kitty image protocol frames are APC sequences beginning with ESC_G and ending in ST.
          expect(stdout).toContain("\u001B_G");
          expect(stdout).toContain("\u001B\\");
          // The box chrome stays visible with the raw source no longer shown.
          expect(rowText(mounted, 0)).toContain("mermaid");
        } finally {
          renderer.dispose();
          mounted.unmount();
        }
      },
    );
  });

  it("copies the full raw mermaid source when clicking the copy button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const restoreClipboard = installNavigatorClipboard(writeText);
    const onCopy = vi.fn();

    try {
      const cols = 32;
      const rows = 6;
      const mounted = await mountTerminal(
        () =>
          h(TMermaidImage, {
            x: 0,
            y: 0,
            w: 24,
            content: SAMPLE_SOURCE,
            onCopy,
          }),
        cols,
        rows,
      );

      try {
        await settle(mounted);
        setDeterministicMetrics(mounted, cols, rows);
        clickCell(mounted, 22, 0);
        await settle(mounted);

        expect(writeText).toHaveBeenCalledWith(SAMPLE_SOURCE);
        expect(onCopy).toHaveBeenCalledWith({ text: SAMPLE_SOURCE, ok: true });
        expect(rowText(mounted, 0)).toContain("copied");
      } finally {
        mounted.unmount();
      }
    } finally {
      restoreClipboard();
    }
  });

  it("copies the full raw mermaid source when clicking the rendered image area", async () => {
    await withEnv(
      {
        KITTY_WINDOW_ID: "vue-tui-test",
        TERM: "xterm-kitty",
        TERM_PROGRAM: "kitty",
        CI: undefined,
        TMUX: undefined,
        VUE_TUI_GRAPHICS_FORCE: "1",
      },
      async () => {
        setMermaidImageRasterizer(async () => ({
          base64: TINY_PNG_BASE64,
          widthCells: 10,
          heightCells: 3,
          naturalWidth: 80,
          naturalHeight: 24,
        }));

        const writeText = vi.fn().mockResolvedValue(undefined);
        const restoreClipboard = installNavigatorClipboard(writeText);
        const onCopy = vi.fn();

        try {
          const cols = 32;
          const rows = 8;
          const mounted = await mountTerminal(
            () =>
              h(TMermaidImage, {
                x: 0,
                y: 0,
                w: 20,
                content: SAMPLE_SOURCE,
                onCopy,
              }),
            cols,
            rows,
          );

          try {
            await settle(mounted);
            setDeterministicMetrics(mounted, cols, rows);
            // Click inside the content area (below the header row), on the image.
            clickCell(mounted, 5, 2);
            await settle(mounted);

            expect(writeText).toHaveBeenCalledWith(SAMPLE_SOURCE);
            expect(onCopy).toHaveBeenCalledWith({ text: SAMPLE_SOURCE, ok: true });
          } finally {
            mounted.unmount();
          }
        } finally {
          restoreClipboard();
        }
      },
    );
  });
});
