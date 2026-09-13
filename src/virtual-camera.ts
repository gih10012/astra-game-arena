import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { AuditLog } from "./audit-log.js";
import { runCommand } from "./command.js";
import type {
  VirtualDashboardRuntime,
  VirtualGameRuntime,
} from "./headless-display.js";
import {
  DIRECTOR_GAME_RECT,
  DIRECTOR_HEIGHT,
  DIRECTOR_WIDTH,
  directorCompositionFilter,
} from "./headless-display.js";

const FPS = 30;

export interface VirtualCameraDevice {
  device: string;
  label: string;
  driver: string;
  writable: boolean;
}

export interface ActiveVirtualCamera {
  device: string;
  close(): Promise<void>;
}

export async function discoverVirtualCameraDevices(): Promise<VirtualCameraDevice[]> {
  const root = "/sys/class/video4linux";
  const names = await readdir(root).catch(() => []);
  const devices = await Promise.all(
    names
      .filter((name) => /^video\d+$/.test(name))
      .map(async (name): Promise<VirtualCameraDevice | null> => {
        const device = path.join("/dev", name);
        const label = (await readFile(path.join(root, name, "name"), "utf8").catch(() => ""))
          .trim();
        const driverPath = await realpath(path.join(root, name, "device/driver")).catch(() => "");
        const driver = driverPath ? path.basename(driverPath) : "unknown";
        if (driver !== "v4l2loopback" && !/(virtual|loopback|astra)/i.test(label)) {
          return null;
        }
        const writable = await access(device, constants.W_OK)
          .then(() => true)
          .catch(() => false);
        return { device, label: label || name, driver, writable };
      }),
  );
  return devices
    .filter((device): device is VirtualCameraDevice => device !== null)
    .sort((left, right) => left.device.localeCompare(right.device));
}

export function virtualCameraFfmpegArguments(options: {
  dashboardDisplay: string;
  device: string;
}): string[] {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "warning",
    "-thread_queue_size", "512",
    "-fflags", "nobuffer",
    "-analyzeduration", "0",
    "-probesize", "32768",
    "-f", "mpegts",
    "-i", "pipe:0",
    "-thread_queue_size", "512",
    "-analyzeduration", "0",
    "-probesize", "32",
    "-f", "x11grab",
    "-draw_mouse", "0",
    "-framerate", String(FPS),
    "-video_size", `${DIRECTOR_WIDTH}x${DIRECTOR_HEIGHT}`,
    "-i", `${options.dashboardDisplay}.0`,
    "-filter_complex",
    directorCompositionFilter("yuyv422", FPS),
    "-map", "[v]",
    "-an", "-sn",
    "-c:v", "rawvideo",
    "-pix_fmt", "yuyv422",
    "-r", String(FPS),
    "-f", "v4l2",
    options.device,
  ];
}

export function virtualCameraGameRecorderArguments(outputName: string): string[] {
  return [
    "-y",
    "-D",
    "-r", String(FPS),
    "--no-dmabuf",
    "-o", outputName,
    "-c", "libx264",
    "-p", "preset=ultrafast",
    "-p", "tune=zerolatency",
    "-p", "crf=18",
    "-p", "keyint=30",
    "-m", "mpegts",
    "-f", "pipe:1",
  ];
}

export function virtualCameraBrowserStreamArguments(device: string): string[] {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "warning",
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-thread_queue_size", "64",
    "-f", "v4l2",
    "-framerate", String(FPS),
    "-video_size", `${DIRECTOR_WIDTH}x${DIRECTOR_HEIGHT}`,
    "-i", device,
    "-vf",
    `crop=${DIRECTOR_GAME_RECT.width}:${DIRECTOR_GAME_RECT.height}:` +
      `${DIRECTOR_GAME_RECT.x}:${DIRECTOR_GAME_RECT.y},fps=${FPS}`,
    "-an", "-sn",
    "-c:v", "mjpeg",
    "-q:v", "5",
    "-flush_packets", "1",
    "-f", "mpjpeg",
    "pipe:1",
  ];
}

export async function startVirtualCamera(options: {
  device: string;
  game: VirtualGameRuntime;
  dashboard: VirtualDashboardRuntime;
  audit: AuditLog;
  onUnexpectedExit?: (message: string) => void;
}): Promise<ActiveVirtualCamera> {
  await waitForWritableVirtualCamera(options.device);

  const gameProcess = spawn(
    "wf-recorder",
    virtualCameraGameRecorderArguments(options.game.captureWayland.output),
    {
      env: options.game.captureWayland.environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const ffmpegProcess = spawn(
    "ffmpeg",
    virtualCameraFfmpegArguments({
      dashboardDisplay: options.dashboard.display,
      device: options.device,
    }),
    { detached: true, stdio: ["pipe", "ignore", "pipe"] },
  );
  gameProcess.stdout?.pipe(ffmpegProcess.stdin!);
  gameProcess.stderr?.on("data", (chunk: Buffer) => {
    void options.audit.appendRaw("virtual-camera-game.log", chunk.toString("utf8"));
  });
  ffmpegProcess.stderr?.on("data", (chunk: Buffer) => {
    void options.audit.appendRaw("virtual-camera-ffmpeg.log", chunk.toString("utf8"));
  });
  let ready = false;
  let closing = false;
  let reported = false;
  const watch = (source: string, process: ChildProcess) => {
    process.once("exit", (code, signal) => {
      if (!ready || closing || reported) return;
      reported = true;
      options.onUnexpectedExit?.(
        `${source} virtual-camera process exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
      );
    });
  };
  watch("game capture", gameProcess);
  watch("ffmpeg", ffmpegProcess);

  await delay(1_000);
  if (!processRunning(gameProcess) || !processRunning(ffmpegProcess)) {
    await Promise.all([stopProcess(gameProcess), stopProcess(ffmpegProcess)]);
    throw new Error(
      `Virtual camera exited early (capture=${gameProcess.exitCode}, output=${ffmpegProcess.exitCode})`,
    );
  }
  await waitForCaptureReady(options.device, gameProcess, ffmpegProcess);
  ready = true;

  return {
    device: options.device,
    close: async () => {
      closing = true;
      gameProcess.stdout?.unpipe(ffmpegProcess.stdin!);
      ffmpegProcess.stdin?.end();
      await Promise.all([stopProcess(ffmpegProcess), stopProcess(gameProcess)]);
    },
  };
}

export async function waitForWritableVirtualCamera(
  device: string,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    discover?: typeof discoverVirtualCameraDevices;
  } = {},
): Promise<VirtualCameraDevice> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 15_000);
  const pollMs = Math.max(1, options.pollMs ?? 250);
  const discover = options.discover ?? discoverVirtualCameraDevices;
  const deadline = Date.now() + timeoutMs;
  let detected = false;
  do {
    const selected = (await discover()).find((entry) => entry.device === device);
    if (selected?.writable) return selected;
    detected ||= selected !== undefined;
    if (Date.now() >= deadline) break;
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  if (!detected) {
    throw new Error(`Virtual camera ${device} is not a detected v4l2loopback device`);
  }
  throw new Error(`Virtual camera ${device} is not writable by this user`);
}

async function waitForCaptureReady(
  device: string,
  gameProcess: ChildProcess,
  ffmpegProcess: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!processRunning(gameProcess) || !processRunning(ffmpegProcess)) break;
    const capabilities = await runCommand("v4l2-ctl", ["--all", "-d", device], {
      timeoutMs: 2_000,
    }).catch(() => null);
    if (
      capabilities?.code === 0 &&
      /\bVideo Capture\b/.test(capabilities.stdout.toString("utf8"))
    ) return;
    await delay(250);
  }
  await Promise.all([stopProcess(gameProcess), stopProcess(ffmpegProcess)]);
  throw new Error(`Virtual camera ${device} did not become readable within 20 seconds`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (!processRunning(child)) return;
  const interrupted = waitForExit(child, 4_000);
  signalGroup(child, "SIGINT");
  await interrupted;
  if (!processRunning(child)) return;
  const terminated = waitForExit(child, 2_000);
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
    // The process already exited.
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
