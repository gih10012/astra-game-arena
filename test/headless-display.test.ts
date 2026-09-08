import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyGpuPreference,
  abortableDelay,
  configureCivilizationViDisplay,
  continuousGameRecorderArguments,
  dashboardRecorderArguments,
  DIRECTOR_GAME_RECT,
  directorCompositionFilter,
  freeXDisplay,
  gameLaunchStrategy,
  runCleanupSteps,
  shouldDirectLaunchGame,
  validateCivilizationViDx11Launch,
} from "../src/headless-display.js";
import { isAuxiliaryGameWindowTitle } from "../src/game-adapter.js";

test("selects a no-Steam direct launch only when offline mode is enabled", () => {
  assert.equal(gameLaunchStrategy({ appId: "289070" }), "steam-managed");
  assert.equal(gameLaunchStrategy({ appId: "289070" }, "steam-online"), "steam-managed");
  assert.equal(gameLaunchStrategy({ appId: "289070" }, "steam-offline"), "steam-managed-offline");
  assert.equal(gameLaunchStrategy({ appId: "1260520" }, "steam-offline"), "steam-managed-offline");
  assert.equal(gameLaunchStrategy({ appId: "289070" }, "direct"), "direct-offline");
  assert.equal(gameLaunchStrategy({ appId: "289070" }, true), "direct-offline");
  assert.equal(gameLaunchStrategy({ appId: "1260520" }), "direct-steam-assisted");
  assert.equal(gameLaunchStrategy({ appId: "1260520" }, true), "direct-offline");
});

test("never direct-launches a Steam-managed offline game", () => {
  assert.equal(shouldDirectLaunchGame("steam-managed-offline"), false);
  assert.equal(shouldDirectLaunchGame("steam-managed"), false);
  assert.equal(shouldDirectLaunchGame("direct-offline"), true);
  assert.equal(shouldDirectLaunchGame("direct-steam-assisted"), true);
});

test("interrupts startup waits promptly with an AbortSignal", async () => {
  const abort = new AbortController();
  const startedAt = Date.now();
  const waiting = abortableDelay(30_000, abort.signal);
  setTimeout(() => abort.abort("operator stop"), 20);
  await assert.rejects(waiting, { name: "AbortError" });
  assert.ok(Date.now() - startedAt < 1_000);
});

test("runs every teardown step before reporting collected failures", async () => {
  const completed: string[] = [];
  await assert.rejects(
    runCleanupSteps([
      () => { throw new Error("restore failed"); },
      () => { completed.push("processes stopped"); },
      () => { completed.push("runtime removed"); },
    ], "cleanup failed"),
    (error: unknown) => error instanceof AggregateError && error.errors.length === 1,
  );
  assert.deepEqual(completed, ["processes stopped", "runtime removed"]);
});

test("validates the active cached Steam user's Civilization VI DX11 wrapper", async () => {
  const steamRoot = await mkdtemp(path.join(os.tmpdir(), "arena-civ6-dx11-"));
  const wrapper = path.join(steamRoot, "civ6-force-dx11.sh");
  const accountConfig = path.join(steamRoot, "userdata", "42", "config");
  await mkdir(path.join(steamRoot, "config"), { recursive: true });
  await mkdir(accountConfig, { recursive: true });
  await writeFile(path.join(steamRoot, "config", "loginusers.vdf"), `"users"
{
  "76561197960265770"
  {
    "AutoLogin" "1"
  }
}`);
  await writeFile(wrapper, `#!/usr/bin/env bash
args=("$@")
for i in "\${!args[@]}"; do
  if [[ "\${args[$i]}" == *"/CivilizationVI_DX12.exe" ]]; then
    args[$i]="\${args[$i]%_DX12.exe}.exe"
  fi
done
exec "\${args[@]}"
`);
  await chmod(wrapper, 0o755);
  await writeFile(path.join(accountConfig, "localconfig.vdf"), `"UserLocalConfigStore"
{
  "Software"
  {
    "Valve"
    {
      "Steam"
      {
        "EmptyPreference" ""
        "apps"
        {
          "289070"
          {
            "LaunchOptions" "${wrapper} %command%"
          }
        }
      }
    }
  }
}`);

  await validateCivilizationViDx11Launch(steamRoot);
  await writeFile(wrapper, `#!/bin/sh
# CivilizationVI_DX12.exe CivilizationVI.exe
exec "$@"
`);
  await assert.rejects(
    validateCivilizationViDx11Launch(steamRoot),
    /does not replace the DX12 executable/,
  );
  await writeFile(path.join(accountConfig, "localconfig.vdf"), `"apps" { "289070" { } }`);
  await assert.rejects(
    validateCivilizationViDx11Launch(steamRoot),
    /DX11 Steam LaunchOptions are missing/,
  );
});

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

test("rejects crash reporters that inherit a game's window class", () => {
  assert.equal(isAuxiliaryGameWindowTitle("Firaxis崩溃报告"), true);
  assert.equal(isAuxiliaryGameWindowTitle("Unity Crash Handler"), true);
  assert.equal(isAuxiliaryGameWindowTitle("Sid Meier's Civilization VI (DX11)"), false);
});

test("aligns Civilization VI's persisted render size with the private display", () => {
  assert.equal(
    configureCivilizationViDisplay("RenderWidth 2560\r\nRenderHeight 1600\r\nFullScreen 1\r\n"),
    "RenderWidth 1920\r\nRenderHeight 1080\r\nFullScreen 1\r\n",
  );
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
  assert.ok(dashboard.includes("1920x1080"));
  assert.ok(dashboard.includes("cfr"));
  assert.equal(dashboard.at(-1), "/run/dashboard.mkv");
  assert.equal([...game, ...dashboard].some((argument) => argument.includes("NIRI_SOCKET")), false);
});

test("composes arbitrary game ratios into the director stage without cropping", () => {
  const filter = directorCompositionFilter("yuv420p");
  assert.ok(filter.includes(
    `scale=${DIRECTOR_GAME_RECT.width}:${DIRECTOR_GAME_RECT.height}:` +
      "force_original_aspect_ratio=decrease:force_divisible_by=2",
  ));
  assert.ok(filter.includes(
    `pad=${DIRECTOR_GAME_RECT.width}:${DIRECTOR_GAME_RECT.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
  ));
  assert.ok(filter.includes(
    `overlay=${DIRECTOR_GAME_RECT.x}:${DIRECTOR_GAME_RECT.y}:shortest=1`,
  ));
  assert.ok(filter.endsWith("format=yuv420p[v]"));
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
