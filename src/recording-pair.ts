import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AuditLog } from "./audit-log.js";
import { expectCommand, runCommand } from "./command.js";
import {
  continuousGameRecorderArguments,
  dashboardRecorderArguments,
  directorCompositionFilter,
  type VirtualDashboardRuntime,
  type VirtualGameRuntime,
} from "./headless-display.js";
import type { RecordingPair } from "./run-checkpoint.js";

const FPS = 30;

export interface ActiveRecordingPair {
  metadata: RecordingPair;
  compositeRelative: string;
  captureStartedAt: string;
  captureStartedWallMs: number;
  captureStartedMono: bigint;
  gameProcess: ChildProcess;
  dashboardProcess: ChildProcess;
  stopping: boolean;
}

export async function startRecordingPair(options: {
  runDirectory: string;
  attempt: number;
  game: VirtualGameRuntime;
  dashboard: VirtualDashboardRuntime;
  audit: AuditLog;
  onUnexpectedExit?: (message: string) => void;
}): Promise<ActiveRecordingPair> {
  const part = String(options.attempt).padStart(4, "0");
  const rawDirectory = path.join(options.runDirectory, "recordings", "raw");
  await mkdir(rawDirectory, { recursive: true });
  const metadata: RecordingPair = {
    attempt: options.attempt,
    game: path.join("recordings", "raw", `game-part-${part}.mkv`),
    dashboard: path.join("recordings", "raw", `dashboard-part-${part}.mkv`),
  };
  const compositeRelative = path.join("recordings", `challenge-part-${part}.mkv`);
  const captureStartedWallMs = Date.now();
  const captureStartedMono = process.hrtime.bigint();
  const captureStartedAt = new Date(captureStartedWallMs).toISOString();
  const gameProcess = spawn(
    "wf-recorder",
    continuousGameRecorderArguments({
      output: path.join(options.runDirectory, metadata.game),
      outputName: options.game.captureWayland.output,
    }),
    {
      env: options.game.captureWayland.environment,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const dashboardProcess = spawn(
    "ffmpeg",
    dashboardRecorderArguments({
      display: options.dashboard.display,
      output: path.join(options.runDirectory, metadata.dashboard),
    }),
    { detached: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  const active: ActiveRecordingPair = {
    metadata,
    compositeRelative,
    captureStartedAt,
    captureStartedWallMs,
    captureStartedMono,
    gameProcess,
    dashboardProcess,
    stopping: false,
  };
  let ready = false;
  const watch = (source: string, process: ChildProcess) => {
    process.once("exit", (code, signal) => {
      if (!ready || active.stopping) return;
      options.onUnexpectedExit?.(
        `${source} recorder exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
      );
    });
  };
  watch("game", gameProcess);
  watch("dashboard", dashboardProcess);
  gameProcess.stderr?.on("data", (chunk: Buffer) => {
    void options.audit.appendRaw(`game-recorder-part-${part}.log`, chunk.toString("utf8"));
  });
  dashboardProcess.stderr?.on("data", (chunk: Buffer) => {
    void options.audit.appendRaw(`dashboard-recorder-part-${part}.log`, chunk.toString("utf8"));
  });
  await delay(1_000);
  if (!processRunning(gameProcess) || !processRunning(dashboardProcess)) {
    await stopProcess(gameProcess);
    await stopProcess(dashboardProcess);
    throw new Error(
      `Continuous recorder exited early (game=${gameProcess.exitCode}, dashboard=${dashboardProcess.exitCode})`,
    );
  }
  ready = true;
  return active;
}

export function recordingPairIsActive(
  pair: ActiveRecordingPair | null,
  attempt: number,
): pair is ActiveRecordingPair {
  return pair !== null &&
    pair.metadata.attempt === attempt &&
    !pair.stopping &&
    processRunning(pair.gameProcess) &&
    processRunning(pair.dashboardProcess);
}

export async function stopAndComposeRecordingPair(
  runDirectory: string,
  pair: ActiveRecordingPair,
): Promise<string> {
  pair.stopping = true;
  await Promise.all([
    stopProcess(pair.gameProcess),
    stopProcess(pair.dashboardProcess),
  ]);
  await composeRecordingPair(runDirectory, pair.metadata, pair.compositeRelative);
  return pair.compositeRelative;
}

export async function composeRecordingPair(
  runDirectory: string,
  pair: RecordingPair,
  compositeRelative = path.join(
    "recordings",
    `challenge-part-${String(pair.attempt).padStart(4, "0")}.mkv`,
  ),
): Promise<string> {
  const game = path.join(runDirectory, pair.game);
  const dashboard = path.join(runDirectory, pair.dashboard);
  const output = path.join(runDirectory, compositeRelative);
  const temporary = `${output}.assembling-${process.pid}-${Date.now()}`;
  const [gameSize, dashboardSize] = await Promise.all([
    stat(game).then((value) => value.size),
    stat(dashboard).then((value) => value.size),
  ]);
  if (gameSize < 1_024 || dashboardSize < 1_024) {
    throw new Error(`Recording part ${pair.attempt} is incomplete`);
  }
  try {
    await expectCommand(
      "ffmpeg",
      [
        "-nostdin", "-hide_banner", "-loglevel", "warning", "-y",
        "-i", game,
        "-i", dashboard,
        "-filter_complex",
        directorCompositionFilter("yuv420p", FPS),
        "-map", "[v]",
        "-an", "-sn",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-fps_mode", "cfr",
        "-f", "matroska",
        temporary,
      ],
      { timeoutMs: 30 * 60_000 },
    );
    if (!(await recordingIsPlayable(temporary))) {
      throw new Error(`Recording part ${pair.attempt} failed validation`);
    }
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return compositeRelative;
}

export async function recoverRecordingPairs(
  runDirectory: string,
  persistedPairs: RecordingPair[],
): Promise<{ recordings: string[]; warnings: string[] }> {
  const pairs = new Map(persistedPairs.map((pair) => [pair.attempt, pair]));
  const rawDirectory = path.join(runDirectory, "recordings", "raw");
  const names = await readdir(rawDirectory).catch(() => []);
  const available = new Set(names);
  for (const name of names) {
    const match = /^game-part-(\d{4})\.mkv$/.exec(name);
    if (!match?.[1]) continue;
    const attempt = Number(match[1]);
    const dashboard = `dashboard-part-${match[1]}.mkv`;
    if (!available.has(dashboard) || pairs.has(attempt)) continue;
    pairs.set(attempt, {
      attempt,
      game: path.join("recordings", "raw", name),
      dashboard: path.join("recordings", "raw", dashboard),
    });
  }

  const recordings: string[] = [];
  const warnings: string[] = [];
  for (const pair of [...pairs.values()].sort((left, right) => left.attempt - right.attempt)) {
    const composite = path.join(
      "recordings",
      `challenge-part-${String(pair.attempt).padStart(4, "0")}.mkv`,
    );
    const output = path.join(runDirectory, composite);
    if (await recordingIsPlayable(output)) {
      recordings.push(composite);
      continue;
    }
    try {
      await access(output);
      await rename(output, `${output}.damaged-${Date.now()}`);
    } catch {
      // A killed runner may have left only the two raw recorder streams.
    }
    try {
      await composeRecordingPair(runDirectory, pair, composite);
      recordings.push(composite);
    } catch (error) {
      warnings.push(`part ${pair.attempt}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { recordings, warnings };
}

async function recordingIsPlayable(filename: string): Promise<boolean> {
  const result = await runCommand("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filename,
  ], { timeoutMs: 30_000 }).catch(() => null);
  if (!result || result.code !== 0) return false;
  const duration = Number(result.stdout.toString("utf8").trim());
  return Number.isFinite(duration) && duration > 0;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (!processRunning(child)) return;
  const interrupted = waitForExit(child, 8_000);
  signalGroup(child, "SIGINT");
  await interrupted;
  if (!processRunning(child)) return;
  const terminated = waitForExit(child, 3_000);
  signalGroup(child, "SIGTERM");
  await terminated;
  if (!processRunning(child)) return;
  const killed = waitForExit(child, 1_000);
  signalGroup(child, "SIGKILL");
  await killed;
}

function processRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const finish = () => {
      clearTimeout(timer);
      child.off("exit", finish);
      resolve();
    };
    child.once("exit", finish);
    timer = setTimeout(finish, timeoutMs);
    timer.unref();
  });
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
