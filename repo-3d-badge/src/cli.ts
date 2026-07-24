#!/usr/bin/env node
/**
 * CLI entry: `repo-3d-badge <repo-url-or-owner/repo>`
 *
 * Fetches the repo's contributors + logo, builds a textured 3D badge in
 * the terminal using WebGPU (via @simon_he/vue-tui), and renders it live.
 *
 * Requires the Bun runtime + bun-webgpu for the 3D renderer.
 * If run under Node, automatically re-execs with bun if available.
 */

import { execSync, spawn } from "node:child_process";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

if (!isBun) {
  // Running under Node — try to find bun and re-exec.
  let bunPath = "";
  try {
    bunPath = execSync("which bun", { encoding: "utf-8" }).trim();
  } catch {
    // bun not found
  }

  if (bunPath) {
    // Re-exec the cli-main.ts with bun, inheriting stdio.
    const mainPath = new URL("./cli-main.js", import.meta.url).pathname;
    const child = spawn(bunPath, [mainPath, ...process.argv.slice(2)], {
      stdio: "inherit",
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  } else {
    process.stderr.write(
      [
        "repo-3d-badge requires the Bun runtime for 3D WebGPU rendering.",
        "",
        "Install Bun:  curl -fsSL https://bun.sh/install | bash",
        "Then run:     bunx repo-3d-badge <github-repo>",
        "",
      ].join("\n") + "\n",
    );
    process.exit(1);
  }
} else {
  // Running under Bun — load the actual CLI logic.
  await import("./cli-main.js");
}
