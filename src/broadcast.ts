import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { durableJsonWrite, type RunPhase } from "./run-checkpoint.js";

export const BROADCAST_CONFIG_FILENAME = "broadcast-config.json";
const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".m4v", ".mov", ".webm"]);
const MAX_LIBRARY_ITEMS = 500;

export type BroadcastMode = "auto" | "live" | "replay";

export interface BroadcastConfiguration {
  version: 1;
  updatedAt: string;
  mode: BroadcastMode;
  playlist: string[];
  manualFiles: string[];
  loop: boolean;
  replayWhenIdle: boolean;
  replayWhenQuota: boolean;
  replayWhenPaused: boolean;
  replayWhenPower: boolean;
  replayWhenRetry: boolean;
  showReplayBadge: boolean;
  replayBadgeText: string;
  showResetTime: boolean;
  audioEnabled: boolean;
  volume: number;
}

export interface BroadcastMediaItem {
  id: string;
  name: string;
  filename: string;
  displayPath: string;
  source: "run" | "library" | "manual";
  bytes: number;
  modifiedAt: string;
}

export interface BroadcastPlaybackDecision {
  mode: "live" | "replay" | "standby";
  reason: string;
}

export function broadcastConfigPath(rootDirectory: string): string {
  return path.join(path.resolve(rootDirectory), ".arena", BROADCAST_CONFIG_FILENAME);
}

export function defaultBroadcastConfiguration(): BroadcastConfiguration {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    mode: "auto",
    playlist: [],
    manualFiles: [],
    loop: true,
    replayWhenIdle: true,
    replayWhenQuota: true,
    replayWhenPaused: false,
    replayWhenPower: false,
    replayWhenRetry: false,
    showReplayBadge: true,
    replayBadgeText: "录播回放",
    showResetTime: true,
    audioEnabled: true,
    volume: 1,
  };
}

export async function readBroadcastConfiguration(
  rootDirectory: string,
): Promise<BroadcastConfiguration> {
  const fallback = defaultBroadcastConfiguration();
  try {
    const value = JSON.parse(
      await readFile(broadcastConfigPath(rootDirectory), "utf8"),
    ) as Partial<BroadcastConfiguration>;
    if (value.version !== 1) return fallback;
    return normalizeBroadcastConfiguration({ ...fallback, ...value });
  } catch {
    return fallback;
  }
}

export async function writeBroadcastConfiguration(
  rootDirectory: string,
  configuration: BroadcastConfiguration,
): Promise<BroadcastConfiguration> {
  const normalized = normalizeBroadcastConfiguration({
    ...configuration,
    version: 1,
    updatedAt: new Date().toISOString(),
  });
  await durableJsonWrite(broadcastConfigPath(rootDirectory), normalized);
  return normalized;
}

export async function discoverBroadcastMedia(
  rootDirectory: string,
  manualFiles: readonly string[] = [],
): Promise<BroadcastMediaItem[]> {
  const root = path.resolve(rootDirectory);
  const candidates = new Map<string, BroadcastMediaItem["source"]>();
  const addFile = async (filename: string, source: BroadcastMediaItem["source"]) => {
    if (!isVideoFilename(filename) || candidates.size >= MAX_LIBRARY_ITEMS) return;
    try {
      const canonical = await realpath(filename);
      const info = await stat(canonical);
      if (info.isFile()) candidates.set(canonical, source);
    } catch {
      // Missing or inaccessible media is omitted from the current library.
    }
  };
  const addDirectory = async (
    directory: string,
    source: BroadcastMediaItem["source"],
    accepted: (name: string) => boolean = isVideoFilename,
  ) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (candidates.size >= MAX_LIBRARY_ITEMS) break;
      if (entry.isFile() && accepted(entry.name)) {
        await addFile(path.join(directory, entry.name), source);
      }
    }
  };

  await addDirectory(path.join(root, ".arena", "broadcast-media"), "library");
  const runEntries = await readdir(path.join(root, "runs"), {
    withFileTypes: true,
  }).catch(() => []);
  for (const run of runEntries.filter((entry) => entry.isDirectory())) {
    if (candidates.size >= MAX_LIBRARY_ITEMS) break;
    const runDirectory = path.join(root, "runs", run.name);
    await addDirectory(path.join(runDirectory, "production"), "run");
    await addDirectory(
      path.join(runDirectory, "recordings"),
      "run",
      (name) => /^challenge-part-\d+\.(?:mkv|mp4|m4v|mov|webm)$/i.test(name),
    );
  }
  for (const filename of manualFiles) await addFile(expandHome(filename), "manual");

  const items = await Promise.all([...candidates].map(async ([filename, source]) => {
    const info = await stat(filename);
    const relative = path.relative(root, filename);
    return {
      id: mediaId(filename),
      name: path.basename(filename),
      filename,
      displayPath: relative && !relative.startsWith(`..${path.sep}`) && relative !== ".."
        ? relative
        : filename,
      source,
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    } satisfies BroadcastMediaItem;
  }));
  return items.sort((left, right) =>
    Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt) ||
    left.displayPath.localeCompare(right.displayPath)
  );
}

export async function validateManualBroadcastFile(filename: string): Promise<string> {
  const resolved = expandHome(filename.trim());
  if (!path.isAbsolute(resolved) || !isVideoFilename(resolved)) {
    throw new Error("Replay media must be an absolute path to a supported video file");
  }
  const canonical = await realpath(resolved);
  const info = await stat(canonical);
  if (!info.isFile()) throw new Error("Replay media must be a regular file");
  return canonical;
}

export function selectedBroadcastMedia(
  configuration: BroadcastConfiguration,
  library: readonly BroadcastMediaItem[],
): BroadcastMediaItem[] {
  const byFilename = new Map(library.map((item) => [item.filename, item]));
  return configuration.playlist.flatMap((filename) => {
    const item = byFilename.get(filename);
    return item ? [item] : [];
  });
}

export function determineBroadcastPlayback(options: {
  configuration: BroadcastConfiguration;
  phase: RunPhase | null;
  liveAvailable: boolean;
  hasReplay: boolean;
}): BroadcastPlaybackDecision {
  const { configuration, phase, liveAvailable, hasReplay } = options;
  if (configuration.mode === "live") {
    return liveAvailable
      ? { mode: "live", reason: "forced-live" }
      : { mode: "standby", reason: "live-unavailable" };
  }
  if (configuration.mode === "replay") {
    return hasReplay
      ? { mode: "replay", reason: "forced-replay" }
      : { mode: "standby", reason: "playlist-empty" };
  }
  if (phase === "running" && liveAvailable) {
    return { mode: "live", reason: "challenge-running" };
  }
  const replayRequested =
    (phase === null && configuration.replayWhenIdle) ||
    (phase === "waiting_quota" && configuration.replayWhenQuota) ||
    (phase === "paused" && configuration.replayWhenPaused) ||
    (phase === "waiting_power" && configuration.replayWhenPower) ||
    (phase === "waiting_retry" && configuration.replayWhenRetry);
  if (replayRequested && hasReplay) {
    return { mode: "replay", reason: phase ?? "idle" };
  }
  return {
    mode: "standby",
    reason: replayRequested ? "playlist-empty" : phase ?? "idle",
  };
}

export function replayFfmpegArguments(filename: string): string[] {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "warning",
    "-re", "-i", filename,
    "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
    "-vf",
    "scale=1920:1080:force_original_aspect_ratio=decrease," +
      "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
    "-crf", "20", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-frag_duration", "1000000",
    "-f", "mp4", "pipe:1",
  ];
}

export function liveAudioFfmpegArguments(source: string): string[] {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "warning",
    "-fflags", "nobuffer",
    "-thread_queue_size", "1024",
    "-f", "pulse", "-i", source,
    "-vn", "-ac", "2", "-ar", "48000",
    "-c:a", "libopus", "-b:a", "128k",
    "-application", "audio", "-frame_duration", "20",
    "-flush_packets", "1", "-f", "ogg", "pipe:1",
  ];
}

function normalizeBroadcastConfiguration(
  value: BroadcastConfiguration,
): BroadcastConfiguration {
  const defaults = defaultBroadcastConfiguration();
  const mode = (["auto", "live", "replay"] as string[]).includes(value.mode)
    ? value.mode
    : defaults.mode;
  return {
    version: 1,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : defaults.updatedAt,
    mode,
    playlist: uniquePaths(value.playlist),
    manualFiles: uniquePaths(value.manualFiles),
    loop: value.loop === true,
    replayWhenIdle: value.replayWhenIdle === true,
    replayWhenQuota: value.replayWhenQuota === true,
    replayWhenPaused: value.replayWhenPaused === true,
    replayWhenPower: value.replayWhenPower === true,
    replayWhenRetry: value.replayWhenRetry === true,
    showReplayBadge: value.showReplayBadge !== false,
    replayBadgeText: typeof value.replayBadgeText === "string" && value.replayBadgeText.trim()
      ? value.replayBadgeText.trim().slice(0, 80)
      : defaults.replayBadgeText,
    showResetTime: value.showResetTime !== false,
    audioEnabled: value.audioEnabled !== false,
    volume: Number.isFinite(value.volume)
      ? Math.min(1, Math.max(0, Number(value.volume)))
      : defaults.volume,
  };
}

function uniquePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((entry) =>
    typeof entry === "string" && entry.length <= 4_096 ? [entry] : []
  ))].slice(0, MAX_LIBRARY_ITEMS);
}

function isVideoFilename(filename: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function mediaId(filename: string): string {
  return createHash("sha256").update(filename).digest("base64url").slice(0, 24);
}

function expandHome(filename: string): string {
  if (filename === "~") return os.homedir();
  if (filename.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), filename.slice(2));
  }
  return path.resolve(filename);
}
