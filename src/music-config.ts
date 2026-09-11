import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { durableJsonWrite } from "./run-checkpoint.js";

export const MUSIC_CONFIG_FILENAME = "music-config.json";

export type MusicProviderKind = "moekoe" | "compatible";
export type QueueOverlayMode = "changes" | "always" | "off";

export interface MusicConfiguration {
  version: 1;
  updatedAt: string;
  enabled: boolean;
  roomId: string;
  requestPrefix: string;
  provider: MusicProviderKind;
  providerBaseUrl: string;
  providerBinary: string;
  profileDirectory: string;
  dailyRecommendations: boolean;
  recommendationCardId: number;
  musicVolume: number;
  queueOverlayMode: QueueOverlayMode;
  queueDisplaySeconds: number;
  nowPlayingEnabled: boolean;
  nowPlayingSeconds: number;
  hintEnabled: boolean;
  hintText: string;
  hintIntervalSeconds: number;
  lyricsEnabled: boolean;
  lyricsXPercent: number;
  lyricsYPercent: number;
  vipAutoClaim: boolean;
  maxQueueLength: number;
}

export function musicConfigPath(rootDirectory: string): string {
  return path.join(path.resolve(rootDirectory), ".arena", MUSIC_CONFIG_FILENAME);
}

export function defaultMusicConfiguration(): MusicConfiguration {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    enabled: false,
    roomId: "1912485907",
    requestPrefix: "点歌",
    provider: "moekoe",
    providerBaseUrl: "http://127.0.0.1:16521",
    providerBinary: "/usr/lib/moekoemusic/api/app_linux",
    profileDirectory: path.join(os.homedir(), ".config", "moekoemusic"),
    dailyRecommendations: true,
    recommendationCardId: 2,
    musicVolume: 0.7,
    queueOverlayMode: "changes",
    queueDisplaySeconds: 12,
    nowPlayingEnabled: true,
    nowPlayingSeconds: 10,
    hintEnabled: true,
    hintText: "发送“点歌 歌名”即可点歌",
    hintIntervalSeconds: 120,
    lyricsEnabled: true,
    lyricsXPercent: 6,
    lyricsYPercent: 53,
    vipAutoClaim: true,
    maxQueueLength: 50,
  };
}

export async function readMusicConfiguration(
  rootDirectory: string,
): Promise<MusicConfiguration> {
  const fallback = defaultMusicConfiguration();
  try {
    const parsed = JSON.parse(
      await readFile(musicConfigPath(rootDirectory), "utf8"),
    ) as Partial<MusicConfiguration>;
    if (parsed.version !== 1) return fallback;
    return normalizeMusicConfiguration({ ...fallback, ...parsed });
  } catch {
    return fallback;
  }
}

export async function writeMusicConfiguration(
  rootDirectory: string,
  configuration: MusicConfiguration,
): Promise<MusicConfiguration> {
  const normalized = normalizeMusicConfiguration({
    ...configuration,
    version: 1,
    updatedAt: new Date().toISOString(),
  });
  await durableJsonWrite(musicConfigPath(rootDirectory), normalized);
  return normalized;
}

export function patchMusicConfiguration(
  current: MusicConfiguration,
  patch: unknown,
): MusicConfiguration {
  const value = objectValue(patch);
  if (!value) throw new Error("Music configuration must be a JSON object");
  const allowed = new Set<keyof MusicConfiguration>([
    "enabled", "roomId", "requestPrefix", "provider", "providerBaseUrl",
    "providerBinary", "profileDirectory", "dailyRecommendations",
    "recommendationCardId", "musicVolume", "queueOverlayMode",
    "queueDisplaySeconds", "nowPlayingEnabled", "nowPlayingSeconds",
    "hintEnabled", "hintText", "hintIntervalSeconds", "lyricsEnabled",
    "lyricsXPercent", "lyricsYPercent", "vipAutoClaim", "maxQueueLength",
  ]);
  const updates = Object.fromEntries(
    Object.entries(value).filter(([key]) => allowed.has(key as keyof MusicConfiguration)),
  ) as Partial<MusicConfiguration>;
  return normalizeMusicConfiguration({ ...current, ...updates });
}

export function normalizeMusicConfiguration(
  value: Partial<MusicConfiguration>,
): MusicConfiguration {
  const fallback = defaultMusicConfiguration();
  const provider = value.provider === "compatible" ? "compatible" : "moekoe";
  const queueOverlayMode = ["changes", "always", "off"].includes(
    String(value.queueOverlayMode),
  ) ? value.queueOverlayMode as QueueOverlayMode : fallback.queueOverlayMode;
  return {
    version: 1,
    updatedAt: validIso(value.updatedAt) ?? fallback.updatedAt,
    enabled: value.enabled === true,
    roomId: boundedText(value.roomId, fallback.roomId, 1, 30),
    requestPrefix: boundedText(value.requestPrefix, fallback.requestPrefix, 1, 20),
    provider,
    providerBaseUrl: validHttpUrl(value.providerBaseUrl) ?? fallback.providerBaseUrl,
    providerBinary: boundedText(value.providerBinary, fallback.providerBinary, 1, 1_024),
    profileDirectory: boundedText(value.profileDirectory, fallback.profileDirectory, 1, 1_024),
    dailyRecommendations: value.dailyRecommendations !== false,
    recommendationCardId: boundedInteger(value.recommendationCardId, 1, 10_000, fallback.recommendationCardId),
    musicVolume: boundedNumber(value.musicVolume, 0, 1, fallback.musicVolume),
    queueOverlayMode,
    queueDisplaySeconds: boundedNumber(value.queueDisplaySeconds, 1, 120, fallback.queueDisplaySeconds),
    nowPlayingEnabled: value.nowPlayingEnabled !== false,
    nowPlayingSeconds: boundedNumber(value.nowPlayingSeconds, 1, 120, fallback.nowPlayingSeconds),
    hintEnabled: value.hintEnabled !== false,
    hintText: boundedText(value.hintText, fallback.hintText, 1, 120),
    hintIntervalSeconds: boundedNumber(value.hintIntervalSeconds, 0, 3_600, fallback.hintIntervalSeconds),
    lyricsEnabled: value.lyricsEnabled !== false,
    lyricsXPercent: boundedNumber(value.lyricsXPercent, 0, 100, fallback.lyricsXPercent),
    lyricsYPercent: boundedNumber(value.lyricsYPercent, 0, 100, fallback.lyricsYPercent),
    vipAutoClaim: value.vipAutoClaim !== false,
    maxQueueLength: boundedInteger(value.maxQueueLength, 1, 200, fallback.maxQueueLength),
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function boundedText(
  value: unknown,
  fallback: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  return text.length >= minimum && text.length <= maximum ? text : fallback;
}

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return Math.round(boundedNumber(value, minimum, maximum, fallback));
}

function validHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString().replace(/\/$/, "")
      : null;
  } catch {
    return null;
  }
}

function validIso(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}
