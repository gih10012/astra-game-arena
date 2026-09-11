import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface MusicTrack {
  id: string;
  hash: string;
  title: string;
  artist: string;
  source: string;
  durationMs?: number;
  durationSeconds?: number;
  artworkUrl?: string;
}

export interface PlayableMusicTrack extends MusicTrack {
  url: string;
  resolvedHash: string;
  quality: string;
}

export interface SyncedLyricWord {
  startMs: number;
  durationMs: number;
  text: string;
}

export interface SyncedLyricLine {
  startMs: number;
  durationMs: number;
  text: string;
  words: SyncedLyricWord[];
}

export interface VipClaimResult {
  claimed: boolean;
  hours?: number;
  message?: string;
}

export interface PreparedMusicTrack {
  track: MusicTrack;
  url: string;
  resolvedHash: string;
  quality: string;
  lyrics: SyncedLyricLine[];
}

export type ParsedLyricLine = SyncedLyricLine;

export interface MoeKoeCredentials {
  token?: string;
  userid?: string;
  dfid?: string;
  t1?: string;
  mid?: string;
  guid?: string;
  dev?: string;
  mac?: string;
}

export interface MusicProvider {
  readonly id: string;
  start(): Promise<void>;
  health(): Promise<boolean>;
  healthy(): Promise<boolean>;
  search(query: string, limit?: number): Promise<MusicTrack[]>;
  dailyRecommendations(cardId?: string | number): Promise<MusicTrack[]>;
  resolvePlayable(track: MusicTrack): Promise<PlayableMusicTrack>;
  lyrics(track: MusicTrack): Promise<SyncedLyricLine[]>;
  prepareTrack(track: MusicTrack): Promise<PreparedMusicTrack>;
  claimVip(): Promise<VipClaimResult>;
  close(): Promise<void>;
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcess;

export interface MoeKoeProviderOptions {
  baseUrl?: string;
  port?: number;
  apiBinaryPath?: string;
  profileDirectory?: string;
  proxyUrl?: string;
  manageProcess?: boolean;
  startupTimeoutMs?: number;
  fetch?: FetchLike;
  spawn?: SpawnLike;
}

interface JsonObject {
  [key: string]: unknown;
}

const QUALITY_ORDER = [
  "viper_tape",
  "viper_clear",
  "viper_atmos",
  "high",
  "flac",
  "320",
  "128",
];

/**
 * Adapter for MoeKoeMusic's local HTTP service. It deliberately reads the
 * existing Chromium profile instead of copying credentials into arena state.
 */
export class MoeKoeProvider implements MusicProvider {
  readonly id = "moekoe";
  readonly baseUrl: string;

  #options: Required<Pick<MoeKoeProviderOptions,
    "port" | "apiBinaryPath" | "profileDirectory" | "startupTimeoutMs"
  >> & MoeKoeProviderOptions;
  #fetch: FetchLike;
  #spawn: SpawnLike;
  #process: ChildProcess | null = null;

  constructor(options: MoeKoeProviderOptions = {}) {
    const port = options.port ?? 16_521;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? `http://127.0.0.1:${port}`);
    this.#options = {
      ...options,
      port,
      apiBinaryPath: options.apiBinaryPath ?? "/usr/lib/moekoemusic/api/app_linux",
      profileDirectory: options.profileDirectory ?? path.join(homedir(), ".config", "moekoemusic"),
      startupTimeoutMs: options.startupTimeoutMs ?? 15_000,
    };
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#spawn = options.spawn ?? ((command, args, spawnOptions) =>
      spawn(command, args, spawnOptions));
  }

  async start(): Promise<void> {
    if (await this.healthy()) return;
    const shouldManage = this.#options.manageProcess ?? this.#options.baseUrl === undefined;
    if (!shouldManage) {
      throw new Error(`Music provider is unavailable at ${this.baseUrl}`);
    }
    if (this.#process && processRunning(this.#process)) {
      await this.#waitUntilHealthy();
      return;
    }

    const args = ["--platform=lite", `--port=${this.#options.port}`];
    if (this.#options.proxyUrl) args.push(`--proxy=${this.#options.proxyUrl}`);
    const child = this.#spawn(this.#options.apiBinaryPath, args, {
      stdio: "ignore",
      env: process.env,
    });
    this.#process = child;
    try {
      await Promise.race([
        this.#waitUntilHealthy(),
        waitForPrematureExit(child),
      ]);
    } catch (error) {
      await stopProcess(child).catch(() => undefined);
      if (this.#process === child) this.#process = null;
      throw error;
    }
  }

  async healthy(): Promise<boolean> {
    try {
      const response = await this.#fetch(new URL("./", `${this.baseUrl}/`), {
        signal: AbortSignal.timeout(1_500),
      });
      // A running local API may answer 404/401 at its root. Any non-5xx HTTP
      // response proves that the dedicated listener is ready.
      return response.status < 500;
    } catch {
      return false;
    }
  }

  async health(): Promise<boolean> {
    return await this.healthy();
  }

  async search(query: string, limit = 10): Promise<MusicTrack[]> {
    const keywords = query.trim();
    if (!keywords) return [];
    const payload = await this.#request("/search", {
      keywords,
      page: "1",
      pagesize: String(clampInteger(limit, 1, 50)),
      type: "1",
    });
    return extractTracks(payload, clampInteger(limit, 1, 50));
  }

  async dailyRecommendations(cardId: string | number = 2): Promise<MusicTrack[]> {
    const payload = await this.#request("/top/card", { card_id: String(cardId) });
    return extractTracks(payload, 200);
  }

  async resolvePlayable(track: MusicTrack): Promise<PlayableMusicTrack> {
    const privilege = await this.#request("/privilege/lite", { hash: track.hash })
      .catch(() => null);
    const candidates = extractPrivilegeCandidates(privilege, track.hash);
    let lastFailure = "no playable URL returned";
    for (const candidate of candidates) {
      try {
        const result = asObject(await this.#request("/song/url", {
          hash: candidate.hash,
          quality: candidate.quality,
          ppage_id: "356753938",
        }));
        const urls = stringArray(result?.url);
        const url = urls[0];
        if (!url || String(result?.extName ?? "").toLowerCase() === "mp4") continue;
        return {
          ...track,
          url,
          resolvedHash: candidate.hash,
          quality: candidate.quality,
        };
      } catch (error) {
        lastFailure = safeErrorMessage(error);
      }
    }
    throw new Error(`Could not resolve ${track.title}: ${lastFailure}`);
  }

  async lyrics(track: MusicTrack): Promise<SyncedLyricLine[]> {
    const search = asObject(await this.#request("/search/lyric", { hash: track.hash }));
    const candidates = Array.isArray(search?.candidates) ? search.candidates : [];
    const candidate = asObject(candidates[0]);
    const id = scalarString(candidate?.id);
    const accesskey = scalarString(candidate?.accesskey);
    if (!id || !accesskey) return [];
    const lyric = asObject(await this.#request("/lyric", {
      id,
      accesskey,
      fmt: "krc",
      decode: "true",
    }));
    const content = scalarString(lyric?.decodeContent);
    return content ? parseKrcLyrics(content) : [];
  }

  async prepareTrack(track: MusicTrack): Promise<PreparedMusicTrack> {
    const playable = await this.resolvePlayable(track);
    const lyrics = await this.lyrics(track).catch(() => []);
    return {
      track,
      url: playable.url,
      resolvedHash: playable.resolvedHash,
      quality: playable.quality,
      lyrics,
    };
  }

  async claimVip(): Promise<VipClaimResult> {
    const payload = asObject(await this.#request("/youth/vip"));
    const data = asObject(payload?.data);
    const hours = finiteNumber(data?.award_vip_hour);
    const claimed = payload?.status === 1 || payload?.status === 200 || hours !== undefined;
    const result: VipClaimResult = { claimed };
    if (hours !== undefined) result.hours = hours;
    const message = scalarString(payload?.message ?? payload?.error_msg);
    if (message) result.message = message;
    return result;
  }

  async close(): Promise<void> {
    const child = this.#process;
    this.#process = null;
    if (child) await stopProcess(child);
  }

  async #waitUntilHealthy(): Promise<void> {
    const deadline = Date.now() + this.#options.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.healthy()) return;
      await delay(100);
    }
    throw new Error(`MoeKoe API did not become healthy at ${this.baseUrl}`);
  }

  async #request(endpoint: string, query: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(endpoint.replace(/^\/+/, ""), `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const authorization = await loadAuthorization(this.#options.profileDirectory);
    const headers = new Headers({ Accept: "application/json" });
    if (authorization) headers.set("Authorization", authorization);
    const response = await this.#fetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`MoeKoe API request failed with HTTP ${response.status}`);
    const payload: unknown = await response.json();
    return payload;
  }
}

export function parseKrcLyrics(content: string): SyncedLyricLine[] {
  const lines: SyncedLyricLine[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const match = /^\[(\d+),(\d+)\](.*)$/.exec(rawLine.trim());
    if (!match) continue;
    const startMs = Number(match[1]);
    const durationMs = Number(match[2]);
    const body = match[3] ?? "";
    const words: SyncedLyricWord[] = [];
    const wordPattern = /<(\d+),(\d+),\d+>([^<]*)/g;
    let word: RegExpExecArray | null;
    while ((word = wordPattern.exec(body)) !== null) {
      const text = word[3] ?? "";
      if (!text) continue;
      words.push({
        startMs: startMs + Number(word[1]),
        durationMs: Number(word[2]),
        text,
      });
    }
    const text = words.length > 0
      ? words.map((entry) => entry.text).join("")
      : body.replace(/<\d+,\d+,\d+>/g, "").trim();
    if (text) lines.push({ startMs, durationMs, text, words });
  }
  return lines.sort((left, right) => left.startMs - right.startMs);
}

async function loadAuthorization(profileDirectory: string): Promise<string> {
  const credentials = await loadMoeKoeCredentials(profileDirectory);
  const ordered: Array<[keyof MoeKoeCredentials, string]> = [
    ["token", "token"],
    ["userid", "userid"],
    ["dfid", "dfid"],
    ["t1", "t1"],
    ["mid", "mid"],
    ["guid", "guid"],
    ["dev", "dev"],
    ["mac", "mac"],
  ];
  return ordered.flatMap(([property, headerName]) => {
    const value = credentials[property];
    return value ? [`${headerName}=${value}`] : [];
  }).join(";");
}

/** Reads the newest logged-in MoeKoe record. Callers must treat this as a secret. */
export async function loadMoeKoeCredentials(
  profileDirectory = path.join(homedir(), ".config", "moekoemusic"),
): Promise<MoeKoeCredentials> {
  const data = await findLatestMoeData(profileDirectory);
  return data ? extractCredentials(data) : {};
}

async function findLatestMoeData(profileDirectory: string): Promise<JsonObject | null> {
  const roots = [
    path.join(profileDirectory, "Local Storage", "leveldb"),
    path.join(profileDirectory, "Default", "Local Storage", "leveldb"),
  ];
  const files: Array<{ filename: string; modifiedMs: number }> = [];
  for (const root of roots) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(?:ldb|log)$/i.test(entry.name)) continue;
      const filename = path.join(root, entry.name);
      const stat = await fs.stat(filename).catch(() => null);
      if (stat) files.push({ filename, modifiedMs: stat.mtimeMs });
    }
  }
  files.sort((left, right) => left.modifiedMs - right.modifiedMs);
  let latest: { modifiedMs: number; offset: number; value: JsonObject } | null = null;
  for (const file of files) {
    const buffer = await fs.readFile(file.filename).catch(() => null);
    if (!buffer) continue;
    const marker = Buffer.from("MoeData", "utf8");
    let markerOffset = -1;
    while ((markerOffset = buffer.indexOf(marker, markerOffset + 1)) >= 0) {
      const candidate = parseBalancedObject(buffer, markerOffset + marker.length);
      if (!candidate) continue;
      if (!latest || file.modifiedMs > latest.modifiedMs ||
        (file.modifiedMs === latest.modifiedMs && markerOffset > latest.offset)) {
        latest = { modifiedMs: file.modifiedMs, offset: markerOffset, value: candidate };
      }
    }
  }
  return latest?.value ?? null;
}

function parseBalancedObject(buffer: Buffer, startOffset: number): JsonObject | null {
  const maximum = Math.min(buffer.length, startOffset + 4 * 1024 * 1024);
  for (let objectStart = startOffset; objectStart < maximum; objectStart += 1) {
    if (buffer[objectStart] !== 0x7b) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = objectStart; cursor < maximum; cursor += 1) {
      const byte = buffer[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (byte === 0x5c) escaped = true;
        else if (byte === 0x22) inString = false;
        continue;
      }
      if (byte === 0x22) inString = true;
      else if (byte === 0x7b) depth += 1;
      else if (byte === 0x7d) {
        depth -= 1;
        if (depth !== 0) continue;
        try {
          const parsed: unknown = JSON.parse(buffer.subarray(objectStart, cursor + 1).toString("utf8"));
          return asObject(parsed);
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

function extractCredentials(root: JsonObject): MoeKoeCredentials {
  const user = asObject(root.UserInfo ?? root.userInfo) ?? {};
  const device = asObject(root.Device ?? root.device ?? root.DeviceInfo) ?? {};
  const from = (key: string): string | undefined =>
    scalarString(user[key] ?? device[key] ?? root[key]);
  const credentials: MoeKoeCredentials = {};
  for (const key of [
    "token",
    "userid",
    "dfid",
    "t1",
    "mid",
    "guid",
    "dev",
    "mac",
  ] as const) {
    const value = from(key);
    if (value) credentials[key] = value;
  }
  return credentials;
}

function extractTracks(payload: unknown, limit: number): MusicTrack[] {
  const root = asObject(payload);
  const data = asObject(root?.data);
  const arrays = [
    data?.lists,
    data?.list,
    data?.song_list,
    data?.info,
    root?.lists,
    root?.list,
    root?.song_list,
    root?.data,
  ].filter(Array.isArray) as unknown[][];
  const source = arrays[0] ?? [];
  const tracks: MusicTrack[] = [];
  const seen = new Set<string>();
  for (const value of source) {
    const item = asObject(value);
    if (!item) continue;
    const hash = firstString(item, ["FileHash", "filehash", "hash", "audio_hash"]);
    const rawTitle = firstString(item, [
      "SongName",
      "songname",
      "song_name",
      "ori_audio_name",
      "FileName",
      "filename",
      "name",
    ]);
    if (!hash || !rawTitle || seen.has(hash)) continue;
    seen.add(hash);
    const artist = firstString(item, [
      "SingerName",
      "singername",
      "author_name",
      "artist",
      "author",
    ]) || "未知歌手";
    const title = stripArtistPrefix(rawTitle, artist);
    const durationMs = trackDurationMs(item);
    const artworkUrl = firstString(item, ["sizable_cover", "image", "img", "cover"])
      .replace("{size}", "480");
    tracks.push({
      id: hash,
      hash,
      title,
      artist,
      source: "moekoe",
      ...(durationMs !== undefined
        ? { durationMs, durationSeconds: durationMs / 1_000 }
        : {}),
      ...(artworkUrl ? { artworkUrl } : {}),
    });
    if (tracks.length >= limit) break;
  }
  return tracks;
}

function extractPrivilegeCandidates(payload: unknown, originalHash: string): Array<{
  hash: string;
  quality: string;
}> {
  const root = asObject(payload);
  const data = Array.isArray(root?.data) ? root.data : [];
  const found = new Map<string, string>();
  for (const value of data) {
    const item = asObject(value);
    const goods = [item, ...(Array.isArray(item?.relate_goods) ? item.relate_goods.map(asObject) : [])];
    for (const good of goods) {
      const hash = scalarString(good?.hash);
      const quality = scalarString(good?.quality);
      if (!hash || !quality || good?.level === 0 || !QUALITY_ORDER.includes(quality)) continue;
      if (!found.has(quality)) found.set(quality, hash);
    }
  }
  const candidates = QUALITY_ORDER.flatMap((quality) => {
    const hash = found.get(quality);
    return hash ? [{ hash, quality }] : [];
  });
  if (!candidates.some((entry) => entry.hash === originalHash && entry.quality === "128")) {
    candidates.push({ hash: originalHash, quality: "128" });
  }
  return candidates;
}

function trackDurationMs(item: JsonObject): number | undefined {
  for (const key of ["time_length", "timelen", "duration_ms"]) {
    const value = finiteNumber(item[key]);
    if (value !== undefined) return Math.round(value * (value < 10_000 ? 1_000 : 1));
  }
  for (const key of ["Duration", "duration"]) {
    const value = finiteNumber(item[key]);
    if (value !== undefined) return Math.round(value * (value < 10_000 ? 1_000 : 1));
  }
  return undefined;
}

function stripArtistPrefix(title: string, artist: string): string {
  const prefixes = [`${artist} - `, `${artist}-`, `${artist} – `];
  return prefixes.find((prefix) => title.startsWith(prefix))
    ? title.slice(prefixes.find((prefix) => title.startsWith(prefix))!.length).trim()
    : title;
}

function firstString(object: JsonObject, keys: string[]): string {
  for (const key of keys) {
    const value = scalarString(object[key]);
    if (value) return value;
  }
  return "";
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value :
    typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string" && value) return [value];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function processRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForPrematureExit(child: ChildProcess): Promise<never> {
  return new Promise((_, reject) => {
    child.once("error", (error) => reject(error));
    child.once("exit", (code, signal) => {
      reject(new Error(`MoeKoe API exited before it became ready (${code ?? signal ?? "unknown"})`));
    });
  });
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (!processRunning(child)) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    delay(2_000).then(() => false),
  ]);
  if (!exited && processRunning(child)) child.kill("SIGKILL");
}
