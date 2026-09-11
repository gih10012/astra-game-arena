import { spawn, type ChildProcess } from "node:child_process";
import { constants, createWriteStream, existsSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./command.js";
import type { InstalledSteamGame } from "./steam-catalog.js";
import { createProcessRuntimeGate } from "./process-runtime-gate.js";
import {
  prepareSteamLoginMode,
  SteamLoginStateUnavailableError,
  type SteamLoginModeLease,
} from "./steam-offline.js";

const GAME_WIDTH = 1920;
export const DIRECTOR_WIDTH = 1920;
export const DIRECTOR_HEIGHT = 1080;

/**
 * Pixel-exact location of `.game-stage` in the 1920x1080 director viewport.
 * The matching geometry lives in `web/styles.css` under `body.director`.
 */
export const DIRECTOR_GAME_RECT = Object.freeze({
  x: 20,
  y: 200,
  width: 1248,
  height: 810,
});

export function directorCompositionFilter(
  outputPixelFormat: "yuv420p" | "yuyv422",
  fps = 30,
): string {
  const rect = DIRECTOR_GAME_RECT;
  return (
    `[0:v]fps=${fps},` +
      `scale=${rect.width}:${rect.height}:force_original_aspect_ratio=decrease:` +
      `force_divisible_by=2:flags=lanczos,` +
      `pad=${rect.width}:${rect.height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `setsar=1,setpts=N/(${fps}*TB)[g];` +
    `[1:v]fps=${fps},` +
      `scale=${DIRECTOR_WIDTH}:${DIRECTOR_HEIGHT}:force_original_aspect_ratio=decrease:` +
      `force_divisible_by=2:flags=lanczos,` +
      `pad=${DIRECTOR_WIDTH}:${DIRECTOR_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `setsar=1,setpts=N/(${fps}*TB)[d];` +
    `[d][g]overlay=${rect.x}:${rect.y}:shortest=1:eof_action=endall,` +
      `fps=${fps},setpts=N/(${fps}*TB),format=${outputPixelFormat}[v]`
  );
}

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
  readonly frozen: boolean;
  readonly frozenProcessIds: readonly number[];
  pause(): Promise<readonly number[]>;
  resume(): Promise<readonly number[]>;
  close(): Promise<void>;
}

export interface VirtualDashboardRuntime {
  display: string;
  close(): Promise<void>;
}

export type GameLaunchStrategy =
  | "direct-offline"
  | "direct-steam-assisted"
  | "steam-managed"
  | "steam-managed-offline";

export function gameLaunchStrategy(
  game: Pick<InstalledSteamGame, "appId">,
  offlineModeOrMode: boolean | "steam-online" | "steam-offline" | "direct" = false,
): GameLaunchStrategy {
  if (offlineModeOrMode === true || offlineModeOrMode === "direct") return "direct-offline";
  if (offlineModeOrMode === "steam-offline") return "steam-managed-offline";
  if (game.appId === "1260520") return "direct-steam-assisted";
  return "steam-managed";
}

export function shouldDirectLaunchGame(strategy: GameLaunchStrategy): boolean {
  return strategy === "direct-offline" || strategy === "direct-steam-assisted";
}

export class VirtualGameStartupAbortedError extends Error {
  override name = "AbortError";

  constructor(reason?: unknown) {
    super("Virtual game startup was cancelled", reason === undefined ? undefined : { cause: reason });
  }
}

export async function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfStartupAborted(signal);
  if (!signal) {
    await delay(milliseconds);
    return;
  }
  const activeSignal = signal;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      activeSignal.removeEventListener("abort", abort);
      reject(new VirtualGameStartupAbortedError(activeSignal.reason));
    };
    function finish() {
      activeSignal.removeEventListener("abort", abort);
      resolve();
    }
    activeSignal.addEventListener("abort", abort, { once: true });
  });
}

export async function runCleanupSteps(
  steps: Array<() => void | Promise<void>>,
  message: string,
): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, message);
}

export async function startVirtualGame(options: {
  rootDirectory: string;
  runtimeDirectory: string;
  game: InstalledSteamGame;
  gpuPreference?: "auto" | "integrated" | "discrete";
  launchMode?: "steam-online" | "steam-offline" | "direct";
  offlineMode?: boolean;
  audioSinkName?: string;
  runtimeId?: string;
  signal?: AbortSignal;
}): Promise<VirtualGameRuntime> {
  throwIfStartupAborted(options.signal);
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
  const launchStrategy = gameLaunchStrategy(
    options.game,
    options.launchMode ?? (options.offlineMode === true ? "direct" : false),
  );
  const runtimeGate = createProcessRuntimeGate(
    options.runtimeId ?? path.basename(options.runtimeDirectory),
  );
  const steamEnabled = launchStrategy !== "direct-offline";
  const directExecutableLaunch = shouldDirectLaunchGame(launchStrategy);
  const steamManagedLaunch = launchStrategy === "steam-managed" ||
    launchStrategy === "steam-managed-offline";
  const steamOfflineLaunch = launchStrategy === "steam-managed-offline";
  const steamRoot = path.join(process.env.HOME ?? os.homedir(), ".local/share/Steam");
  if (steamManagedLaunch && options.game.appId === "289070") {
    await validateCivilizationViDx11Launch(steamRoot);
  }
  throwIfStartupAborted(options.signal);
  // Resolve Proton for every Windows launch, including Steam-managed games.
  // Steam can detach Wine descendants from the `steam` launcher process group;
  // keeping the Proton command available lets us clean that game's prefix both
  // before startup and during teardown.
  const proton = options.game.platform === "windows"
    ? await resolveProton()
    : null;
  const keypressCommand = await ensureKeypressHelper(options.rootDirectory);
  const anchorCommand = await ensureX11Anchor(options.rootDirectory);
  const environmentFile = path.join(options.runtimeDirectory, "headless-environment.json");
  const compositorLog = path.join(options.runtimeDirectory, "compositor.log");
  const cageHostEntry = path.join(options.rootDirectory, "dist/src/cage-host.js");
  await access(cageHostEntry);

  const runtimeEnvironment = withoutPhysicalDisplay(process.env);
  const sessionRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
  if (options.audioSinkName) {
    runtimeEnvironment.PULSE_SINK = options.audioSinkName;
    runtimeEnvironment.PULSE_PROP = "application.name=Astra Private Game";
    if (sessionRuntimeDirectory) {
      runtimeEnvironment.PULSE_SERVER ??= `unix:${sessionRuntimeDirectory}/pulse/native`;
      runtimeEnvironment.PIPEWIRE_RUNTIME_DIR ??= sessionRuntimeDirectory;
    }
  }
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
  let cleanupGameEnvironment: NodeJS.ProcessEnv | null = null;
  let cleanupSteamEnvironment: NodeJS.ProcessEnv | null = null;
  let steamLoginLease: SteamLoginModeLease | null = null;
  let restoreGameDisplayConfig: (() => Promise<void>) | null = null;
  let restoreCommunityMods: (() => Promise<void>) | null = null;
  let steamProcess: ChildProcess | null = null;
  let steamEnvironment: NodeJS.ProcessEnv | null = null;

  try {
    const hostEnvironment = await waitForJsonEnvironment(
      environmentFile,
      cageProcess,
      30_000,
      options.signal,
    );
    const display = hostEnvironment.DISPLAY;
    if (!display || !hostEnvironment.WAYLAND_DISPLAY) {
      throw new Error("Cage did not report its private displays");
    }
    const childEnvironment = {
      ...runtimeEnvironment,
      ...hostEnvironment,
    };
    const gameEnvironment: NodeJS.ProcessEnv = {
      ...childEnvironment,
      ...runtimeGate.environment,
      STEAM_COMPAT_DATA_PATH: path.join(steamRoot, "steamapps/compatdata", options.game.appId),
      STEAM_COMPAT_CLIENT_INSTALL_PATH: steamRoot,
      SteamAppId: options.game.appId,
      SteamGameId: options.game.appId,
      PROTON_LOG: "1",
      PROTON_LOG_DIR: options.runtimeDirectory,
    };
    cleanupGameEnvironment = gameEnvironment;
    const captureEnvironment: NodeJS.ProcessEnv = {
      ...runtimeEnvironment,
      WAYLAND_DISPLAY: hostEnvironment.WAYLAND_DISPLAY,
      XDG_RUNTIME_DIR: hostEnvironment.XDG_RUNTIME_DIR,
    };
    // The project-local Cage runtime may intentionally carry a wlroots-only
    // library directory. Native capture tools are built against the host's
    // current FFmpeg ABI and must not inherit that compositor loader path.
    if (process.env.LD_LIBRARY_PATH) {
      captureEnvironment.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH;
    } else {
      delete captureEnvironment.LD_LIBRARY_PATH;
    }
    const outputResult = await runCommand("wlr-randr", ["--json"], {
      env: captureEnvironment,
      timeoutMs: 5_000,
    });
    if (outputResult.code !== 0) {
      throw new Error(`Cannot inspect private recording output: ${outputResult.stderr.toString("utf8").trim()}`);
    }
    throwIfStartupAborted(options.signal);
    const outputs = JSON.parse(outputResult.stdout.toString("utf8")) as Array<{ name?: string }>;
    const captureOutput = outputs[0]?.name;
    if (!captureOutput) throw new Error("Private recording output is unavailable");
    if (await steamIsRunning()) {
      throw new Error(
        "Steam is already running. Close it before a headless challenge so it cannot forward the game to the physical desktop.",
      );
    }
    if (proton && existsSync(path.join(gameEnvironment.STEAM_COMPAT_DATA_PATH!, "pfx"))) {
      await stopProtonPrefix(proton, gameEnvironment);
    }
    restoreGameDisplayConfig = await prepareGameDisplayConfig({
      game: options.game,
      compatDataDirectory: gameEnvironment.STEAM_COMPAT_DATA_PATH!,
      runtimeDirectory: options.runtimeDirectory,
    });
    restoreCommunityMods = await prepareCommunityMods({
      game: options.game,
      compatDataDirectory: gameEnvironment.STEAM_COMPAT_DATA_PATH!,
      runtimeDirectory: options.runtimeDirectory,
    });
    throwIfStartupAborted(options.signal);
    if (steamEnabled) {
      steamEnvironment = {
        ...childEnvironment,
        ...runtimeGate.environment,
        PROTON_LOG: "1",
        PROTON_LOG_DIR: options.runtimeDirectory,
      };
      cleanupSteamEnvironment = steamEnvironment;
      try {
        // Keep the selected Steam mode scoped to this private runtime.  This
        // also prevents a user's previous offline flag from leaking into an
        // explicitly requested online launch.
        steamLoginLease = await prepareSteamLoginMode(steamRoot, steamOfflineLaunch);
      } catch (error) {
        if (steamOfflineLaunch || !(error instanceof SteamLoginStateUnavailableError)) {
          throw error;
        }
        // Online Steam can still start for a profile without the optional
        // cached-mode keys; there is simply nothing to restore in that case.
      }
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
        await waitForXDisplay(steamDisplay, steamXvfbProcess, 15_000, options.signal);
        steamEnvironment.DISPLAY = steamDisplay;
      }
      // Force Steam and its game child onto a private X display.  In
      // particular, do not let a native Wayland Steam client discover niri.
      delete steamEnvironment.WAYLAND_DISPLAY;
      const steamArguments = [
        "-inhibitbootstrap",
        "-skipinitialbootstrap",
        "-nobootstrapperupdate",
        "-noverifyfiles",
        "-silent",
        ...(steamOfflineLaunch ? ["-offline"] : []),
      ];
      steamProcess = spawn("steam", steamArguments, {
        env: steamEnvironment,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      logChildOutput(steamProcess, path.join(options.runtimeDirectory, "steam.log"));
      childProcesses.push(steamProcess);
      await waitForSteamReady(steamProcess, 30 * 60_000, options.signal);

      // Sending -applaunch during a cold Steam startup can be replayed by both
      // the updater and the final client.  Hand it to the ready client once.
      if (steamManagedLaunch) {
        await abortableDelay(5_000, options.signal);
        const launchProcess = spawn("steam", [
          "-applaunch", options.game.appId,
          "-screen-fullscreen", "0",
          "-screen-width", String(GAME_WIDTH),
          "-screen-height", String(DIRECTOR_HEIGHT),
        ], {
          env: steamEnvironment,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        logChildOutput(launchProcess, path.join(options.runtimeDirectory, "steam-launch.log"));
        childProcesses.push(launchProcess);
      }
    }

    let gameProcess: ChildProcess | null = null;
    if (directExecutableLaunch) {
      gameProcess = spawn(
        proton ?? options.game.executable,
        proton ? [
          "run", options.game.executable,
          "-screen-fullscreen", "0",
          "-screen-width", String(GAME_WIDTH),
          "-screen-height", String(DIRECTOR_HEIGHT),
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
      await abortableDelay(1_500, options.signal);
      if (gameProcess.exitCode !== null) {
        throw new Error(
          `Game process exited before creating a window (code=${gameProcess.exitCode}); ` +
            `see ${path.join(options.runtimeDirectory, "game.log")}`,
        );
      }
    }
    throwIfStartupAborted(options.signal);

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
      get frozen() {
        return runtimeGate.frozen;
      },
      get frozenProcessIds() {
        return runtimeGate.processIds;
      },
      pause: () => runtimeGate.freeze(),
      resume: () => runtimeGate.thaw(),
      close: async () => {
        await runCleanupSteps([
          () => runtimeGate.thaw(),
          () => { if (gameProcess) stopProcessGroup(gameProcess, "SIGTERM"); },
          () => delay(500),
          () => proton ? stopProtonPrefix(proton, gameEnvironment) : undefined,
          async () => {
            if (!steamProcess || !steamEnvironment) return;
            await runCommand("steam", ["-shutdown"], {
              env: steamEnvironment,
              timeoutMs: 5_000,
            }).catch(() => undefined);
          },
          () => { if (steamProcess) stopProcessGroup(steamProcess, "SIGTERM"); },
          () => steamProcess ? ensureSteamStopped() : undefined,
          () => steamLoginLease?.restore(),
          () => restoreCommunityMods?.(),
          () => restoreGameDisplayConfig?.(),
          () => stopProcessGroup(cageProcess, "SIGTERM"),
          () => delay(1_000),
          () => { for (const child of childProcesses) stopProcessGroup(child, "SIGKILL"); },
          () => rm(waylandRuntimeDirectory, { recursive: true, force: true }),
        ], "Virtual game teardown was incomplete");
      },
    };
  } catch (error) {
    try {
      await runCleanupSteps([
        () => runtimeGate.thaw(),
        async () => {
          if (!cleanupSteamEnvironment) return;
          await runCommand("steam", ["-shutdown"], {
            env: cleanupSteamEnvironment,
            timeoutMs: 5_000,
          }).catch(() => undefined);
        },
        () => { if (steamProcess) stopProcessGroup(steamProcess, "SIGTERM"); },
        () => cleanupSteamEnvironment ? ensureSteamStopped() : undefined,
        () => steamLoginLease?.restore(),
        () => proton && cleanupGameEnvironment
          ? stopProtonPrefix(proton, cleanupGameEnvironment)
          : undefined,
        () => restoreCommunityMods?.(),
        () => restoreGameDisplayConfig?.(),
        () => { for (const child of childProcesses) stopProcessGroup(child, "SIGKILL"); },
        () => rm(waylandRuntimeDirectory, { recursive: true, force: true }),
      ], "Virtual game startup cleanup was incomplete");
    } catch (cleanupError) {
      const cleanupErrors = cleanupError instanceof AggregateError
        ? cleanupError.errors
        : [cleanupError];
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Virtual game startup failed and cleanup was incomplete",
        { cause: error },
      );
    }
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
    [display, "-screen", "0", `${DIRECTOR_WIDTH}x${DIRECTOR_HEIGHT}x24`, "-nolisten", "tcp", "-noreset"],
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
        "--force-device-scale-factor=1",
        `--window-size=${DIRECTOR_WIDTH},${DIRECTOR_HEIGHT}`,
        `--app=${options.url}/?director=1`,
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
  audioSource?: string;
}): string[] {
  return [
    "-D",
    "-r", "30",
    "--no-dmabuf",
    "-o", options.outputName,
    ...(options.audioSource
      ? [
        `--audio=${options.audioSource}`,
        "-C", "libopus",
        "-R", "48000",
        "-P", "b=160k",
      ]
      : []),
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
    "-video_size", `${DIRECTOR_WIDTH}x${DIRECTOR_HEIGHT}`,
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
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfStartupAborted(signal);
    if (steamProcess.exitCode !== null) {
      throw new Error(`Steam exited before becoming ready (${steamProcess.exitCode})`);
    }
    const webHelper = await runCommand("pgrep", ["-f", "/steamwebhelper"], {
      timeoutMs: 1_000,
    });
    if (webHelper.code === 0) return;
    await abortableDelay(1_000, signal);
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
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    throwIfStartupAborted(signal);
    if (process.exitCode !== null) throw new Error("Private compositor exited before it was ready");
    try {
      return JSON.parse(await readFile(filename, "utf8")) as Record<string, string>;
    } catch (error) {
      lastError = error;
      await abortableDelay(100, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Private compositor startup timed out");
}

async function waitForXDisplay(
  display: string,
  process: ChildProcess,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfStartupAborted(signal);
    if (process.exitCode !== null) throw new Error("Xvfb exited before it was ready");
    const result = await runCommand("xprop", ["-display", display, "-root"], {
      timeoutMs: 1_000,
    });
    if (result.code === 0) return;
    await abortableDelay(100, signal);
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

async function ensureSteamStopped(): Promise<void> {
  const waitUntilStopped = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await steamIsRunning())) return true;
      await delay(250);
    }
    return !(await steamIsRunning());
  };
  if (await waitUntilStopped(10_000)) return;
  await runCommand("pkill", ["-TERM", "-x", "steam"], { timeoutMs: 2_000 })
    .catch(() => undefined);
  if (await waitUntilStopped(3_000)) return;
  await runCommand("pkill", ["-KILL", "-x", "steam"], { timeoutMs: 2_000 })
    .catch(() => undefined);
  if (!(await waitUntilStopped(2_000))) {
    throw new Error("Steam did not stop during virtual game teardown");
  }
}

function throwIfStartupAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new VirtualGameStartupAbortedError(signal.reason);
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

async function stopProtonPrefix(
  proton: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await runCommand(proton, ["runinprefix", "wineserver", "-k"], {
    env: environment,
    timeoutMs: 5_000,
  }).catch(() => undefined);
}

interface VdfObject {
  [key: string]: string | VdfObject;
}

export async function validateCivilizationViDx11Launch(steamRoot: string): Promise<void> {
  const loginUsersPath = path.join(steamRoot, "config", "loginusers.vdf");
  const loginUsers = parseVdf(await readFile(loginUsersPath, "utf8"));
  const users = objectValue(loginUsers.users);
  const cachedUsers = users
    ? Object.entries(users).filter((entry): entry is [string, VdfObject] =>
        objectValue(entry[1]) !== null
      ).map(([steamId, value]) => [steamId, value as VdfObject] as const)
    : [];
  const steamId = cachedUsers.find(([, value]) => value.MostRecent === "1")?.[0] ??
    cachedUsers.find(([, value]) => value.AutoLogin === "1")?.[0] ??
    (cachedUsers.length === 1 ? cachedUsers[0]?.[0] : undefined);
  if (!steamId || !/^\d+$/.test(steamId)) {
    throw new Error("Civilization VI DX11 launch requires an unambiguous cached Steam user");
  }

  const accountId = (BigInt(steamId) & 0xffff_ffffn).toString();
  const localConfigPath = path.join(
    steamRoot,
    "userdata",
    accountId,
    "config",
    "localconfig.vdf",
  );
  const localConfig = parseVdf(await readFile(localConfigPath, "utf8").catch(() => {
    throw new Error("Civilization VI DX11 Steam launch configuration is missing");
  }));
  const launchOptions = findAppLaunchOptions(localConfig, "289070");
  if (!launchOptions) {
    throw new Error("Civilization VI DX11 Steam LaunchOptions are missing");
  }
  const wrapperToken = /(?:^|\s)(?:"([^"]+)"|'([^']+)'|(\S+))\s+%command%(?=\s|$)/
    .exec(launchOptions);
  const wrapper = wrapperToken?.[1] ?? wrapperToken?.[2] ?? wrapperToken?.[3];
  if (!wrapper || !path.isAbsolute(wrapper)) {
    throw new Error("Civilization VI DX11 LaunchOptions must wrap %command% with an absolute script path");
  }
  try {
    await access(wrapper, constants.R_OK | constants.X_OK);
  } catch {
    throw new Error("Civilization VI DX11 launch wrapper is missing or not executable");
  }
  const script = (await readFile(wrapper, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#.*$/, ""))
    .join("\n");
  if (
    !/\[\[[^\n]*CivilizationVI_DX12\.exe[^\n]*\]\]/i.test(script) ||
    !/args\[[^\n]+\]\s*=\s*"\$\{args\[[^\n]+\]%_DX12\.exe\}\.exe"/i.test(script) ||
    !/\bexec\s+"\$\{args\[@\]\}"/.test(script)
  ) {
    throw new Error("Civilization VI launch wrapper does not replace the DX12 executable with DX11");
  }
  await verifyCivilizationViDx11WrapperBehavior(wrapper);
}

async function verifyCivilizationViDx11WrapperBehavior(wrapper: string): Promise<void> {
  const probeDirectory = await mkdtemp(path.join(os.tmpdir(), "astra-civ6-dx11-probe-"));
  const probeCommand = path.join(probeDirectory, "capture-arguments.sh");
  const probeOutput = path.join(probeDirectory, "arguments.txt");
  const dx12Argument = path.join(probeDirectory, "CivilizationVI_DX12.exe");
  const dx11Argument = path.join(probeDirectory, "CivilizationVI.exe");
  const marker = "astra-dx11-probe";
  try {
    await writeFile(
      probeCommand,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "$ASTRA_CIV6_DX11_PROBE_OUTPUT"\n`,
      { mode: 0o700 },
    );
    const result = await runCommand(wrapper, [probeCommand, dx12Argument, marker], {
      env: {
        ...process.env,
        ASTRA_CIV6_DX11_PROBE_OUTPUT: probeOutput,
      },
      timeoutMs: 2_000,
    });
    const actualArguments = result.code === 0
      ? await readFile(probeOutput, "utf8").catch(() => "")
      : "";
    const lines = actualArguments.split(/\r?\n/).filter(Boolean);
    if (
      result.code !== 0 ||
      !lines.includes(dx11Argument) ||
      lines.includes(dx12Argument) ||
      !lines.includes(marker)
    ) {
      throw new Error("Civilization VI DX11 launch wrapper failed its argument-rewrite probe");
    }
  } finally {
    await rm(probeDirectory, { recursive: true, force: true });
  }
}

function parseVdf(source: string): VdfObject {
  const tokens = [...source.matchAll(/"((?:\\.|[^"\\])*)"|([{}])/g)].map((match) =>
    match[2] ?? decodeVdfString(match[1] ?? "")
  );
  let cursor = 0;
  const readObject = (nested: boolean): VdfObject => {
    const result: VdfObject = {};
    while (cursor < tokens.length) {
      const key = tokens[cursor++];
      if (key === "}") {
        if (!nested) throw new Error("Unexpected closing brace in Steam VDF");
        return result;
      }
      if (!key || key === "{") throw new Error("Invalid Steam VDF key");
      const value = tokens[cursor++];
      if (value === "{") result[key] = readObject(true);
      else if (value !== undefined && value !== "}") result[key] = value;
      else throw new Error("Invalid Steam VDF value");
    }
    if (nested) throw new Error("Unclosed object in Steam VDF");
    return result;
  };
  return readObject(false);
}

function decodeVdfString(value: string): string {
  return value.replace(/\\(["\\])/g, "$1");
}

function objectValue(value: string | VdfObject | undefined): VdfObject | null {
  return value !== undefined && typeof value === "object" ? value : null;
}

function findAppLaunchOptions(value: VdfObject, appId: string): string | null {
  for (const [key, child] of Object.entries(value)) {
    const object = objectValue(child);
    if (key === appId && object && typeof object.LaunchOptions === "string") {
      return object.LaunchOptions;
    }
    if (object) {
      const nested = findAppLaunchOptions(object, appId);
      if (nested) return nested;
    }
  }
  return null;
}

export function configureCivilizationViDisplay(text: string): string {
  return text
    .replace(/^RenderWidth[ \t]+\d+[ \t]*(\r?)$/m, `RenderWidth ${GAME_WIDTH}$1`)
    .replace(/^RenderHeight[ \t]+\d+[ \t]*(\r?)$/m, `RenderHeight ${DIRECTOR_HEIGHT}$1`);
}

async function prepareGameDisplayConfig(options: {
  game: InstalledSteamGame;
  compatDataDirectory: string;
  runtimeDirectory: string;
}): Promise<() => Promise<void>> {
  if (options.game.appId !== "289070") return async () => undefined;
  const filename = path.join(
    options.compatDataDirectory,
    "pfx/drive_c/users/steamuser/AppData/Local/Firaxis Games/" +
      "Sid Meier's Civilization VI/AppOptions.txt",
  );
  if (!existsSync(filename)) return async () => undefined;

  const runDirectory = path.dirname(path.dirname(options.runtimeDirectory));
  const recoveryFilename = path.join(runDirectory, "runtime-config-recovery.json");
  try {
    const recovery = JSON.parse(await readFile(recoveryFilename, "utf8")) as {
      appId?: string;
      originalBase64?: string;
    };
    if (recovery.appId === options.game.appId && recovery.originalBase64) {
      await writeFile(filename, Buffer.from(recovery.originalBase64, "base64"));
    }
  } catch {
    // No interrupted temporary configuration to recover.
  }

  const original = await readFile(filename);
  const configured = configureCivilizationViDisplay(original.toString("utf8"));
  if (configured === original.toString("utf8")) return async () => undefined;
  const backupDirectory = path.join(options.runtimeDirectory, "game-config-backup");
  await mkdir(backupDirectory, { recursive: true });
  await writeFile(path.join(backupDirectory, "AppOptions.txt"), original);
  await writeFile(recoveryFilename, JSON.stringify({
    version: 1,
    appId: options.game.appId,
    filename,
    originalBase64: original.toString("base64"),
  }));
  await writeFile(filename, configured);

  let restored = false;
  return async () => {
    if (restored) return;
    restored = true;
    await writeFile(filename, original);
    await rm(recoveryFilename, { force: true });
  };
}

async function prepareCommunityMods(options: {
  game: InstalledSteamGame;
  compatDataDirectory: string;
  runtimeDirectory: string;
}): Promise<() => Promise<void>> {
  if (options.game.appId !== "289070") return async () => undefined;
  const filename = path.join(
    options.compatDataDirectory,
    "pfx/drive_c/users/steamuser/AppData/Local/Firaxis Games/" +
      "Sid Meier's Civilization VI/Mods.sqlite",
  );
  if (!existsSync(filename)) return async () => undefined;

  const runDirectory = path.dirname(path.dirname(options.runtimeDirectory));
  const recoveryFilename = path.join(runDirectory, "community-mods-recovery.json");
  try {
    const recovery = JSON.parse(await readFile(recoveryFilename, "utf8")) as {
      appId?: string;
      originalBase64?: string;
    };
    if (recovery.appId === options.game.appId && recovery.originalBase64) {
      await writeFile(filename, Buffer.from(recovery.originalBase64, "base64"));
    }
    await rm(recoveryFilename, { force: true });
  } catch {
    // No interrupted temporary mod state to recover.
  }

  const sqlite = await runCommand("which", ["sqlite3"], { timeoutMs: 2_000 });
  if (sqlite.code !== 0) return async () => undefined;
  const communityPredicate =
    "lower(replace(s.Path, char(92), '/')) like '%/workshop/content/289070/%'";
  const count = await runCommand("sqlite3", [filename,
    `select count(*) from ModGroupItems i join Mods m using(ModRowId) ` +
      `join ScannedFiles s using(ScannedFileRowId) where i.Disabled=0 and ${communityPredicate};`,
  ], { timeoutMs: 5_000 });
  const enabledCommunityMods = Number(count.stdout.toString("utf8").trim());
  if (count.code !== 0 || !Number.isFinite(enabledCommunityMods) || enabledCommunityMods === 0) {
    return async () => undefined;
  }

  const original = await readFile(filename);
  const backupDirectory = path.join(options.runtimeDirectory, "game-config-backup");
  await mkdir(backupDirectory, { recursive: true });
  await writeFile(path.join(backupDirectory, "Mods.sqlite"), original);
  await writeFile(recoveryFilename, JSON.stringify({
    version: 1,
    appId: options.game.appId,
    filename,
    originalBase64: original.toString("base64"),
  }));
  const update = await runCommand("sqlite3", [filename,
    `update ModGroupItems set Disabled=1 where ModRowId in (` +
      `select m.ModRowId from Mods m join ScannedFiles s using(ScannedFileRowId) ` +
      `where ${communityPredicate});`,
  ], { timeoutMs: 5_000 });
  if (update.code !== 0) {
    await writeFile(filename, original);
    await rm(recoveryFilename, { force: true });
    throw new Error(`Could not isolate Civilization VI community mods: ${update.stderr.toString("utf8").trim()}`);
  }

  let restored = false;
  return async () => {
    if (restored) return;
    restored = true;
    await writeFile(filename, original);
    await rm(recoveryFilename, { force: true });
  };
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
