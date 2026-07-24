import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts", "src/cli-main.ts", "src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: [
    "@simon_he/vue-tui",
    "@simon_he/vue-tui/cli",
    "@simon_he/vue-tui/experimental",
    "@simon_he/vue-tui/experimental/3d/bun",
    "bun-webgpu",
    "pngjs",
    "jpeg-js",
    "vue",
    "node:zlib",
  ],
  unbundle: true,
});
