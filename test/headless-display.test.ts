import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyGpuPreference,
  continuousGameRecorderArguments,
  dashboardRecorderArguments,
  freeXDisplay,
} from "../src/headless-display.js";

test("maps discrete GPU selection to PRIME offload variables", () => {
  const environment: NodeJS.ProcessEnv = {};
  applyGpuPreference(environment, "discrete");
  assert.deepEqual(environment, {
    __NV_PRIME_RENDER_OFFLOAD: "1",
    __VK_LAYER_NV_optimus: "NVIDIA_only",
    __GLX_VENDOR_LIBRARY_NAME: "nvidia",
    DRI_PRIME: "1",
  });
});

test("records the continuous private compositor and dashboard displays", () => {
  const game = continuousGameRecorderArguments({
    outputName: "HEADLESS-1",
    output: "/run/game.mkv",
  });
  assert.ok(game.includes("HEADLESS-1"));
  assert.ok(game.includes("30"));
  assert.ok(game.includes("--no-dmabuf"));
  assert.equal(game.at(-1), "/run/game.mkv");

  const dashboard = dashboardRecorderArguments({
    display: ":97",
    output: "/run/dashboard.mkv",
  });
  assert.ok(dashboard.includes(":97.0"));
  assert.ok(dashboard.includes("640x1080"));
  assert.ok(dashboard.includes("cfr"));
  assert.equal(dashboard.at(-1), "/run/dashboard.mkv");
  assert.equal([...game, ...dashboard].some((argument) => argument.includes("NIRI_SOCKET")), false);
});

test("reclaims stale private X sockets while preserving a live display", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-x-display-"));
  const sockets = path.join(root, "sockets");
  await mkdir(sockets);
  await Promise.all([
    writeFile(path.join(sockets, "X170"), "stale"),
    writeFile(path.join(root, ".X170-lock"), "2147483647\n"),
    writeFile(path.join(sockets, "X171"), "live"),
    writeFile(path.join(root, ".X171-lock"), `${process.pid}\n`),
  ]);

  assert.equal(await freeXDisplay(170, 171, {
    socketDirectory: sockets,
    lockDirectory: root,
  }), ":170");
  assert.equal(await freeXDisplay(171, 172, {
    socketDirectory: sockets,
    lockDirectory: root,
  }), ":172");
});
