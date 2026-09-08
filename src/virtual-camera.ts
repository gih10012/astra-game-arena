import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { AuditLog } from "./audit-log.js";
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
    "-f", "matroska",
    "-i", "pipe:0",
    "-thread_queue_size", "512",
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
    "-m", "matroska",
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
}): Promise<ActiveVirtualCamera> {
  const available = await discoverVirtualCameraDevices();
  const selected = available.find((entry) => entry.device === options.device);
  if (!selected) {
    throw new Error(
      `Virtual camera ${options.device} is not a detected v4l2loopback device`,
    );
  }
  if (!selected.writable) {
    throw new Error(`Virtual camera ${options.device} is not writable by this user`);
  }

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

  await delay(1_000);
  if (gameProcess.exitCode !== null || ffmpegProcess.exitCode !== null) {
    await Promise.all([stopProcess(gameProcess), stopProcess(ffmpegProcess)]);
    throw new Error(
      `Virtual camera exited early (capture=${gameProcess.exitCode}, output=${ffmpegProcess.exitCode})`,
    );
  }

  return {
    device: options.device,
    close: async () => {
      gameProcess.stdout?.unpipe(ffmpegProcess.stdin!);
      ffmpegProcess.stdin?.end();
      await Promise.all([stopProcess(ffmpegProcess), stopProcess(gameProcess)]);
    },
  };
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  signalGroup(child, "SIGINT");
  await Promise.race([once(child, "exit"), delay(4_000)]).catch(() => undefined);
  if (child.exitCode === null) signalGroup(child, "SIGTERM");
  await Promise.race([once(child, "exit"), delay(2_000)]).catch(() => undefined);
  if (child.exitCode === null) signalGroup(child, "SIGKILL");
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
