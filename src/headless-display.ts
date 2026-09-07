import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./command.js";
import type { InstalledSteamGame } from "./steam-catalog.js";

const GAME_WIDTH = 1280;
const VIDEO_HEIGHT = 1080;
const DASHBOARD_WIDTH = 640;

export interface VirtualGameRuntime {
  display: string;
  keypressCommand: string;
  compositorScreenshot: {
    command: string;
    arguments: string[];
    environment: NodeJS.ProcessEnv;
  };
  captureWayland: {
    output: string;
    environment: NodeJS.ProcessEnv;
  };
  close(): Promise<void>;
}

export interface VirtualDashboardRuntime {
  display: string;
  close(): Promise<void>;
}

export type GameLaunchStrategy = "direct-offline" | "direct-steam-assisted" | "steam-managed";

export function gameLaunchStrategy(
  game: Pick<InstalledSteamGame, "appId">,
  offlineMode = false,
): GameLaunchStrategy {
  if (offlineMode) return "direct-offline";
  if (game.appId === "1260520") return "direct-steam-assisted";
  return "steam-managed";
}

export async function startVirtualGame(options: {
  rootDirectory: string;
  runtimeDirectory: string;
  game: InstalledSteamGame;
  gpuPreference?: "auto" | "integrated" | "discrete";
  offlineMode?: boolean;
}): Promise<VirtualGameRuntime> {
  await mkdir(options.runtimeDirectory, { recursive: true });
  const xvfb = await resolveTool(
    "Xvfb",
    process.env.ASTRA_XVFB,
    path.join(options.rootDirectory, ".arena/tools/xvfb-root/usr/bin/Xvfb"),
  );
  const cage = await resolveTool(
    "cage",
    process.env.ASTRA_CAGE,
    path.join(options.rootDirectory, ".arena/tools/cage-root/usr/bin/cage"),
  );
  // Parabox has a verified direct-Proton adapter.  Offline mode deliberately
  // extends that direct launch to any selected game and never starts Steam;
  // Steamworks/DRM-dependent titles are expected to reject that mode cleanly.
  const launchStrategy = gameLaunchStrategy(options.game, options.offlineMode);
  const steamEnabled = launchStrategy !== "direct-offline";
  const directExecutableLaunch = launchStrategy !== "steam-managed";
  const steamManagedLaunch = launchStrategy === "steam-managed";
  const proton = options.game.platform === "windows" && directExecutableLaunch
    ? await resolveProton()
    : null;
  const keypressCommand = await ensureKeypressHelper(options.rootDirectory);
  const anchorCommand = await ensureX11Anchor(options.rootDirectory);
  const environmentFile = path.join(options.runtimeDirectory, "headless-environment.json");
  const compositorLog = path.join(options.runtimeDirectory, "compositor.log");
  const cageHostEntry = path.join(options.rootDirectory, "dist/src/cage-host.js");
  await access(cageHostEntry);

  const runtimeEnvironment = withoutPhysicalDisplay(process.env);
  applyGpuPreference(runtimeEnvironment, options.gpuPreference ?? "auto");
  const runtimeBase = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  const waylandRuntimeDirectory = await mkdtemp(path.join(runtimeBase, "astra-game-"));
  await chmod(waylandRuntimeDirectory, 0o700);
  runtimeEnvironment.XDG_RUNTIME_DIR = waylandRuntimeDirectory;
  runtimeEnvironment.WLR_BACKENDS = "headless";
  runtimeEnvironment.WLR_HEADLESS_OUTPUTS = "1";
  runtimeEnvironment.WLR_LIBINPUT_NO_DEVICES = "1";
  runtimeEnvironment.WLR_RENDERER = "gles2";
  const cageLibrary = path.resolve(path.dirname(cage), "../lib");
  if (existsSync(cageLibrary)) {
    runtimeEnvironment.LD_LIBRARY_PATH = [
      cageLibrary,
      runtimeEnvironment.LD_LIBRARY_PATH,
    ].filter(Boolean).join(":");
  }
  const cageProcess = spawn(
    cage,
    [
      "--",
      process.execPath,
      cageHostEntry,
      anchorCommand,
      environmentFile,
    ],
    {
      cwd: options.rootDirectory,
      env: runtimeEnvironment,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  cageProcess.stderr?.pipe(createWriteStream(compositorLog, { flags: "a" }));
  const childProcesses: ChildProcess[] = [cageProcess];

  try {
    const hostEnvironment = await waitForJsonEnvironment(
      environmentFile,
      cageProcess,
      30_000,
    );
    const display = hostEnvironment.DISPLAY;
    if (!display || !hostEnvironment.WAYLAND_DISPLAY) {
      throw new Error("Cage did not report its private displays");
    }
    const childEnvironment = {
      ...runtimeEnvironment,
      ...hostEnvironment,
    };
    const captureEnvironment: NodeJS.ProcessEnv = {
      ...runtimeEnvironment,
      WAYLAND_DISPLAY: hostEnvironment.WAYLAND_DISPLAY,
      XDG_RUNTIME_DIR: hostEnvironment.XDG_RUNTIME_DIR,
    };
    const outputResult = await runCommand("wlr-randr", ["--json"], {
      env: captureEnvironment,
      timeoutMs: 5_000,
    });
    if (outputResult.code !== 0) {
      throw new Error(`Cannot inspect private recording output: ${outputResult.stderr.toString("utf8").trim()}`);
    }
    const outputs = JSON.parse(outputResult.stdout.toString("utf8")) as Array<{ name?: string }>;
    const captureOutput = outputs[0]?.name;
    if (!captureOutput) throw new Error("Private recording output is unavailable");
    if (await steamIsRunning()) {
      throw new Error(
        "Steam is already running. Close it before a headless challenge so it cannot forward the game to the physical desktop.",
      );
    }
    let steamProcess: ChildProcess | null = null;
    let steamEnvironment: NodeJS.ProcessEnv | null = null;
    if (steamEnabled) {
      steamEnvironment = {
        ...childEnvironment,
        SteamAppId: options.game.appId,
        SteamGameId: options.game.appId,
        PROTON_LOG: "1",
        PROTON_LOG_DIR: options.runtimeDirectory,
      };
      if (directExecutableLaunch) {
        const steamDisplay = await freeXDisplay(170, 199);
        const steamXvfbProcess = spawn(
          xvfb,
          [steamDisplay, "-screen", "0", "1024x768x24", "-br", "-nolisten", "tcp", "-noreset"],
          { detached: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        logChildOutput(
          steamXvfbProcess,
          path.join(options.runtimeDirectory, "steam-xvfb.log"),
        );
        childProcesses.push(steamXvfbProcess);
        await waitForXDisplay(steamDisplay, steamXvfbProcess, 15_000);
        steamEnvironment.DISPLAY = steamDisplay;
      }
      // Force Steam and its game child onto a private X display.  In
      // particular, do not let a native Wayland Steam client discover niri.
      delete steamEnvironment.WAYLAND_DISPLAY;
      steamProcess = spawn("steam", [
        "-inhibitbootstrap",
        "-skipinitialbootstrap",
        "-nobootstrapperupdate",
        "-noverifyfiles",
        "-silent",
      ], {
        env: steamEnvironment,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      logChildOutput(steamProcess, path.join(options.runtimeDirectory, "steam.log"));
      childProcesses.push(steamProcess);
      await waitForSteamReady(steamProcess, 30 * 60_000);

      // Sending -applaunch during a cold Steam startup can be replayed by both
      // the updater and the final client.  Hand it to the ready client once.
      if (steamManagedLaunch) {
        await delay(5_000);
        const launchProcess = spawn("steam", [
          "-applaunch", options.game.appId,
          "-screen-fullscreen", "0",
          "-screen-width", String(GAME_WIDTH),
          "-screen-height", String(VIDEO_HEIGHT),
        ], {
          env: steamEnvironment,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        logChildOutput(launchProcess, path.join(options.runtimeDirectory, "steam-launch.log"));
        childProcesses.push(launchProcess);
      }
    }

    const steamRoot = path.join(process.env.HOME ?? "", ".local/share/Steam");
    const gameEnvironment: NodeJS.ProcessEnv = {
      ...childEnvironment,
      STEAM_COMPAT_DATA_PATH: path.join(steamRoot, "steamapps/compatdata", options.game.appId),
      STEAM_COMPAT_CLIENT_INSTALL_PATH: steamRoot,
      SteamAppId: options.game.appId,
      SteamGameId: options.game.appId,
      PROTON_LOG: "1",
      PROTON_LOG_DIR: options.runtimeDirectory,
    };
    let gameProcess: ChildProcess | null = null;
    if (directExecutableLaunch) {
      gameProcess = spawn(
        proton ?? options.game.executable,
        proton ? [
          "run", options.game.executable,
          "-screen-fullscreen", "0",
          "-screen-width", String(GAME_WIDTH),
          "-screen-height", String(VIDEO_HEIGHT),
        ] : [],
        {
          env: gameEnvironment,
          cwd: options.game.installDirectory,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      logChildOutput(gameProcess, path.join(options.runtimeDirectory, "game.log"));
      childProcesses.push(gameProcess);
      await delay(1_500);
      if (gameProcess.exitCode !== null) {
        throw new Error(
          `Game process exited before creating a window (code=${gameProcess.exitCode}); ` +
            `see ${path.join(options.runtimeDirectory, "game.log")}`,
        );
      }
    }

    return {
      display,
      keypressCommand,
      compositorScreenshot: {
        command: "grim",
        arguments: ["-o", captureOutput],
        environment: captureEnvironment,
      },
      captureWayland: {
        output: captureOutput,
        environment: captureEnvironment,
      },
      close: async () => {
        if (gameProcess) stopProcessGroup(gameProcess, "SIGTERM");
        await delay(500);
        if (proton && gameProcess) {
          await runCommand(proton, ["runinprefix", "wineserver", "-k"], {
            env: gameEnvironment,
            timeoutMs: 5_000,
          }).catch(() => undefined);
        }
        if (steamProcess && steamEnvironment) {
          await runCommand("steam", ["-shutdown"], {
            env: steamEnvironment,
            timeoutMs: 5_000,
          }).catch(() => undefined);
          stopProcessGroup(steamProcess, "SIGTERM");
        }
        stopProcessGroup(cageProcess, "SIGTERM");
        await delay(1_000);
        for (const child of childProcesses) stopProcessGroup(child, "SIGKILL");
        await rm(waylandRuntimeDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    for (const child of childProcesses) stopProcessGroup(child, "SIGKILL");
    await rm(waylandRuntimeDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function applyGpuPreference(
  environment: NodeJS.ProcessEnv,
  preference: "auto" | "integrated" | "discrete",
): void {
  if (preference === "discrete") {
    environment.__NV_PRIME_RENDER_OFFLOAD = "1";
    environment.__VK_LAYER_NV_optimus = "NVIDIA_only";
    environment.__GLX_VENDOR_LIBRARY_NAME = "nvidia";
    environment.DRI_PRIME = "1";
  } else if (preference === "integrated") {
    environment.__NV_PRIME_RENDER_OFFLOAD = "0";
    environment.__VK_LAYER_NV_optimus = "non_NVIDIA_only";
    environment.__GLX_VENDOR_LIBRARY_NAME = "mesa";
    environment.DRI_PRIME = "0";
  }
}

export async function startVirtualDashboard(options: {
  rootDirectory: string;
  runtimeDirectory: string;
  url: string;
}): Promise<VirtualDashboardRuntime> {
  const xvfb = await resolveTool(
    "Xvfb",
    process.env.ASTRA_XVFB,
    path.join(options.rootDirectory, ".arena/tools/xvfb-root/usr/bin/Xvfb"),
  );
  const display = await freeXDisplay(90, 129);
  const xvfbProcess = spawn(
    xvfb,
    [display, "-screen", "0", `${DASHBOARD_WIDTH}x${VIDEO_HEIGHT}x24`, "-nolisten", "tcp", "-noreset"],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  logChildOutput(xvfbProcess, path.join(options.runtimeDirectory, "xvfb.log"));
  try {
    await waitForXDisplay(display, xvfbProcess, 15_000);
    const chromeEnvironment = withoutPhysicalDisplay(process.env);
    chromeEnvironment.DISPLAY = display;
    chromeEnvironment.XDG_SESSION_TYPE = "x11";
    chromeEnvironment.LANGUAGE = "en_US:en";
    chromeEnvironment.LANG = "en_US.UTF-8";
    const chromeProfile = path.join(options.runtimeDirectory, "dashboard-chrome-profile");
    await mkdir(path.join(chromeProfile, "Default"), { recursive: true });
    await writeFile(path.join(chromeProfile, "Default/Preferences"), JSON.stringify({
      browser: { enable_spellchecking: false },
      translate: { enabled: false },
      translate_blocked_languages: ["en", "zh-CN", "zh"],
    }));
    const chromeProcess = spawn(
      "google-chrome-stable",
      [
        "--ozone-platform=x11",
        `--user-data-dir=${chromeProfile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-session-crashed-bubble",
        "--disable-component-update",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-extensions",
        "--hide-scrollbars",
        "--disable-sync",
        "--disable-translate",
        "--disable-features=Translate,TranslateUI,LanguageDetectionAPI,OptimizationHints,MediaRouter,PushMessaging",
        "--lang=en-US",
        "--accept-lang=en-US",
        "--window-position=0,0",
        `--window-size=${DASHBOARD_WIDTH},${VIDEO_HEIGHT}`,
        `--app=${options.url}/?compact=1`,
      ],
      {
        env: chromeEnvironment,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    logChildOutput(
      chromeProcess,
      path.join(options.runtimeDirectory, "dashboard-chrome.log"),
    );
    await delay(3_000);
    if (chromeProcess.exitCode !== null) {
      throw new Error("Hidden director Chrome exited before recording");
    }
    return {
      display,
      close: async () => {
        stopProcessGroup(chromeProcess, "SIGTERM");
        stopProcessGroup(xvfbProcess, "SIGTERM");
        await delay(500);
        stopProcessGroup(chromeProcess, "SIGKILL");
        stopProcessGroup(xvfbProcess, "SIGKILL");
      },
    };
  } catch (error) {
    stopProcessGroup(xvfbProcess, "SIGKILL");
    throw error;
  }
}

export function continuousGameRecorderArguments(options: {
  output: string;
  outputName: string;
}): string[] {
  return [
    "-D",
    "-r", "30",
    "--no-dmabuf",
    "-o", options.outputName,
    "-c", "libx264",
    "-p", "preset=veryfast",
    "-p", "crf=18",
    "-p", "keyint=60",
    "-f", options.output,
  ];
}

export function dashboardRecorderArguments(options: {
  display: string;
  output: string;
}): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "warning",
    "-y",
    "-thread_queue_size", "512",
    "-f", "x11grab",
    "-draw_mouse", "0",
    "-framerate", "30",
    "-video_size", `${DASHBOARD_WIDTH}x${VIDEO_HEIGHT}`,
    "-i", `${options.display}.0`,
    "-vf", "setsar=1,setpts=N/(30*TB)",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-fps_mode", "cfr",
    "-f", "matroska",
    options.output,
  ];
}

async function ensureKeypressHelper(rootDirectory: string): Promise<string> {
  const output = path.join(rootDirectory, ".arena/bin/astra-x11-keypress");
  const source = path.join(rootDirectory, "native/x11-keypress.c");
  await mkdir(path.dirname(output), { recursive: true });
  let rebuild = true;
  try {
    rebuild = (await stat(output)).mtimeMs < (await stat(source)).mtimeMs;
  } catch {
    rebuild = true;
  }
  if (rebuild) {
    const result = await runCommand(
      "cc",
      ["-O2", "-Wall", "-Wextra", "-Werror", source, "-o", output, "-lX11", "-lXtst", "-lm"],
      { timeoutMs: 30_000 },
    );
    if (result.code !== 0) {
      throw new Error(`Cannot build X11 key helper: ${result.stderr.toString("utf8").trim()}`);
    }
  }
  return output;
}

async function ensureX11Anchor(rootDirectory: string): Promise<string> {
  const output = path.join(rootDirectory, ".arena/bin/astra-x11-anchor");
  const source = path.join(rootDirectory, "native/x11-anchor.c");
  await mkdir(path.dirname(output), { recursive: true });
  let rebuild = true;
  try {
    rebuild = (await stat(output)).mtimeMs < (await stat(source)).mtimeMs;
  } catch {
    rebuild = true;
  }
  if (rebuild) {
    const result = await runCommand(
      "cc",
      ["-O2", "-Wall", "-Wextra", "-Werror", source, "-o", output, "-lX11"],
      { timeoutMs: 30_000 },
    );
    if (result.code !== 0) {
      throw new Error(`Cannot build X11 anchor: ${result.stderr.toString("utf8").trim()}`);
    }
  }
  return output;
}

async function waitForSteamReady(
  steamProcess: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (steamProcess.exitCode !== null) {
      throw new Error(`Steam exited before becoming ready (${steamProcess.exitCode})`);
    }
    const webHelper = await runCommand("pgrep", ["-f", "/steamwebhelper"]);
    if (webHelper.code === 0) return;
    await delay(1_000);
  }
  throw new Error("Steam did not become ready within 30 minutes");
}

async function resolveTool(
  command: string,
  override: string | undefined,
  localFallback: string,
): Promise<string> {
  if (override) {
    await access(override);
    return path.resolve(override);
  }
  const result = await runCommand("which", [command]);
  if (result.code === 0) return result.stdout.toString("utf8").trim();
  await access(localFallback);
  return localFallback;
}

async function resolveProton(): Promise<string> {
  const override = process.env.ASTRA_PROTON;
  if (override) {
    await access(override);
    return path.resolve(override);
  }
  const steamRoot = path.join(process.env.HOME ?? "", ".local/share/Steam");
  const roots = [
    path.join(steamRoot, "compatibilitytools.d"),
    path.join(steamRoot, "steamapps/common"),
  ];
  const candidates: string[] = [];
  for (const root of roots) {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !/proton/i.test(entry.name)) continue;
      const executable = path.join(root, entry.name, "proton");
      if (existsSync(executable)) candidates.push(executable);
    }
  }
  candidates.sort((left, right) => protonRank(right) - protonRank(left));
  if (!candidates[0]) throw new Error("No Proton launcher found; set ASTRA_PROTON");
  return candidates[0];
}

function protonRank(filename: string): number {
  if (/experimental.*ext4/i.test(filename)) return 30;
  if (/experimental/i.test(filename)) return 20;
  return 10;
}

async function waitForJsonEnvironment(
  filename: string,
  process: ChildProcess,
  timeoutMs: number,
): Promise<Record<string, string>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error("Private compositor exited before it was ready");
    try {
      return JSON.parse(await readFile(filename, "utf8")) as Record<string, string>;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Private compositor startup timed out");
}

async function waitForXDisplay(
  display: string,
  process: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error("Xvfb exited before it was ready");
    const result = await runCommand("xprop", ["-display", display, "-root"], {
      timeoutMs: 1_000,
    });
    if (result.code === 0) return;
    await delay(100);
  }
  throw new Error("Xvfb startup timed out");
}

export async function freeXDisplay(
  first: number,
  last: number,
  paths: { socketDirectory?: string; lockDirectory?: string } = {},
): Promise<string> {
  const socketDirectory = paths.socketDirectory ?? "/tmp/.X11-unix";
  const lockDirectory = paths.lockDirectory ?? "/tmp";
  for (let number = first; number <= last; number++) {
    const socket = path.join(socketDirectory, `X${number}`);
    const lock = path.join(lockDirectory, `.X${number}-lock`);
    if (!existsSync(socket) && !existsSync(lock)) return `:${number}`;

    const lockPid = await readFile(lock, "utf8")
      .then((value) => Number(value.trim()))
      .catch(() => Number.NaN);
    if (Number.isInteger(lockPid) && processIsAlive(lockPid)) continue;

    if (socketDirectory === "/tmp/.X11-unix") {
      const probe = await runCommand("xprop", ["-display", `:${number}`, "-root"], {
        timeoutMs: 500,
      });
      if (probe.code === 0) continue;
    }

    await Promise.all([
      rm(socket, { force: true }),
      rm(lock, { force: true }),
    ]);
    if (!existsSync(socket) && !existsSync(lock)) return `:${number}`;
  }
  throw new Error(`No free X display between :${first} and :${last}`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function steamIsRunning(): Promise<boolean> {
  const result = await runCommand("pgrep", ["-x", "steam"]);
  return result.code === 0;
}

function withoutPhysicalDisplay(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...source };
  delete environment.DISPLAY;
  delete environment.WAYLAND_DISPLAY;
  delete environment.NIRI_SOCKET;
  delete environment.XDG_CURRENT_DESKTOP;
  return environment;
}

function stopProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process has already exited.
    }
  }
  // Proton descendants can outlive the launcher while retaining its inherited
  // stdout/stderr pipes.  Detach those pipes during teardown so a finished
  // runner cannot keep the watchdog blocked waiting for Node's event loop.
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function logChildOutput(child: ChildProcess, filename: string): void {
  const output = createWriteStream(filename, { flags: "a" });
  child.stdout?.on("data", (chunk: Buffer) => output.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => output.write(chunk));
  child.once("close", () => output.end());
  child.once("error", () => output.end());
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
