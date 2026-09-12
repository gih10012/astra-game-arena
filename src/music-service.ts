import { spawn, type ChildProcess } from "node:child_process";
import type { ServerResponse } from "node:http";
import {
  BilibiliDanmakuClient,
  type BilibiliDanmakuState,
} from "./bilibili-danmaku.js";
import { runCommand } from "./command.js";
import {
  patchMusicConfiguration,
  readMusicConfiguration,
  writeMusicConfiguration,
  type MusicConfiguration,
} from "./music-config.js";
import {
  MoeKoeProvider,
  type MusicProvider,
  type MusicTrack,
  type PreparedMusicTrack,
  type SyncedLyricLine,
  type VipClaimResult,
} from "./moekoe-provider.js";

const MUSIC_SINK = "astra_broadcast_music";

export interface QueuedMusicTrack {
  track: MusicTrack;
  requestedBy: string;
  requestedAt: string;
  recommendation: boolean;
}

export interface CurrentMusicTrack extends QueuedMusicTrack {
  startedAt: string;
  lyrics: SyncedLyricLine[];
}

export interface PublicMusicSnapshot {
  configuration: MusicConfiguration;
  runtime: {
    phase: "disabled" | "starting" | "ready" | "error";
    provider: "stopped" | "ready" | "error";
    danmaku: BilibiliDanmakuState;
    audio: "stopped" | "ready" | "playing" | "error";
    error: string | null;
    lastCommentAt: string | null;
    lastVipClaim: (VipClaimResult & { at: string }) | null;
  };
  current: CurrentMusicTrack | null;
  queue: QueuedMusicTrack[];
  queueChangedAt: string;
}

interface MusicServiceDependencies {
  providerFactory?: (configuration: MusicConfiguration) => MusicProvider;
  danmakuFactory?: (
    configuration: MusicConfiguration,
    callbacks: {
      onComment: (text: string, userName: string) => void;
      onState: (state: BilibiliDanmakuState) => void;
      onError: (error: Error) => void;
    },
  ) => BilibiliDanmakuClient;
  spawn?: typeof spawn;
  pulse?: boolean;
  random?: () => number;
  retryDelayMs?: number;
}

export class MusicService {
  readonly rootDirectory: string;
  readonly #onChange: (snapshot: PublicMusicSnapshot) => void;
  readonly #providerFactory: (configuration: MusicConfiguration) => MusicProvider;
  readonly #danmakuFactory: NonNullable<MusicServiceDependencies["danmakuFactory"]>;
  readonly #spawn: typeof spawn;
  readonly #pulseEnabled: boolean;
  readonly #random: () => number;
  readonly #retryDelayMs: number;
  #configuration: MusicConfiguration;
  #phase: PublicMusicSnapshot["runtime"]["phase"] = "disabled";
  #providerState: PublicMusicSnapshot["runtime"]["provider"] = "stopped";
  #audioState: PublicMusicSnapshot["runtime"]["audio"] = "stopped";
  #danmakuState: BilibiliDanmakuState = {
    phase: "idle", roomId: null, reconnectAttempt: 0, error: null,
  };
  #provider: MusicProvider | null = null;
  #danmaku: BilibiliDanmakuClient | null = null;
  #player: ChildProcess | null = null;
  #sinkModuleId: string | null = null;
  #audioClients = new Map<ServerResponse, ChildProcess>();
  #queue: QueuedMusicTrack[] = [];
  #current: CurrentMusicTrack | null = null;
  #recommendations: MusicTrack[] = [];
  #recent = new Set<string>();
  #queueChangedAt = new Date(0).toISOString();
  #error: string | null = null;
  #lastCommentAt: string | null = null;
  #lastVipClaim: (VipClaimResult & { at: string }) | null = null;
  #generation = 0;
  #activation: Promise<void> = Promise.resolve();
  #playRetry: NodeJS.Timeout | null = null;

  private constructor(
    rootDirectory: string,
    configuration: MusicConfiguration,
    onChange: (snapshot: PublicMusicSnapshot) => void,
    dependencies: MusicServiceDependencies,
  ) {
    this.rootDirectory = rootDirectory;
    this.#configuration = configuration;
    this.#onChange = onChange;
    this.#providerFactory = dependencies.providerFactory ?? defaultProviderFactory;
    this.#danmakuFactory = dependencies.danmakuFactory ?? defaultDanmakuFactory;
    this.#spawn = dependencies.spawn ?? spawn;
    this.#pulseEnabled = dependencies.pulse !== false;
    this.#random = dependencies.random ?? Math.random;
    this.#retryDelayMs = Math.max(100, dependencies.retryDelayMs ?? 15_000);
  }

  static async open(
    rootDirectory: string,
    onChange: (snapshot: PublicMusicSnapshot) => void = () => undefined,
    dependencies: MusicServiceDependencies = {},
  ): Promise<MusicService> {
    const configuration = await readMusicConfiguration(rootDirectory);
    return new MusicService(rootDirectory, configuration, onChange, dependencies);
  }

  get snapshot(): PublicMusicSnapshot {
    return {
      configuration: { ...this.#configuration },
      runtime: {
        phase: this.#phase,
        provider: this.#providerState,
        danmaku: { ...this.#danmakuState },
        audio: this.#audioState,
        error: this.#error,
        lastCommentAt: this.#lastCommentAt,
        lastVipClaim: this.#lastVipClaim ? { ...this.#lastVipClaim } : null,
      },
      current: this.#current ? cloneCurrent(this.#current) : null,
      queue: this.#queue.map(cloneQueued),
      queueChangedAt: this.#queueChangedAt,
    };
  }

  activate(): Promise<void> {
    this.#activation = this.#activation.then(() => this.#reconcile(true));
    return this.#activation;
  }

  async update(patch: unknown): Promise<PublicMusicSnapshot> {
    const previous = this.#configuration;
    this.#configuration = await writeMusicConfiguration(
      this.rootDirectory,
      patchMusicConfiguration(previous, patch),
    );
    const restart = operationalKey(previous) !== operationalKey(this.#configuration);
    await this.#setSinkVolume().catch(() => undefined);
    this.#notify();
    this.#activation = this.#activation.then(() => this.#reconcile(restart));
    await this.#activation;
    return this.snapshot;
  }

  async requestSong(query: string, requestedBy = "控制台"): Promise<QueuedMusicTrack> {
    const normalized = query.trim();
    if (normalized.length < 1 || normalized.length > 200) {
      throw new Error("歌名必须为 1 至 200 个字符");
    }
    const provider = this.#provider;
    if (!this.#configuration.enabled || !provider) {
      throw new Error("点歌服务尚未启用或音乐源未就绪");
    }
    const track = (await provider.search(normalized, 8))[0];
    if (!track) throw new Error(`没有找到歌曲：${normalized}`);
    const item: QueuedMusicTrack = {
      track,
      requestedBy: requestedBy.trim().slice(0, 80) || "观众",
      requestedAt: new Date().toISOString(),
      recommendation: false,
    };
    if (this.#hasTrack(track.id)) {
      throw new Error(`${track.title} 已在播放或队列中`);
    }
    if (this.#queue.length >= this.#configuration.maxQueueLength) {
      throw new Error("点歌队列已满");
    }
    this.#queue.push(item);
    this.#queueChangedAt = new Date().toISOString();
    this.#notify();
    if (!this.#current && !this.#player) void this.#playNext(this.#generation);
    return cloneQueued(item);
  }

  async skip(): Promise<void> {
    const player = this.#player;
    if (player && processRunning(player)) {
      stopProcessGroup(player);
      return;
    }
    this.#current = null;
    await this.#playNext(this.#generation);
  }

  async claimVip(): Promise<VipClaimResult & { at: string }> {
    if (!this.#provider) throw new Error("音乐源未就绪");
    const result = await this.#provider.claimVip();
    this.#lastVipClaim = { ...result, at: new Date().toISOString() };
    this.#notify();
    return { ...this.#lastVipClaim };
  }

  startAudioStream(response: ServerResponse): void {
    if (!this.#configuration.enabled || !this.#sinkModuleId || !this.#pulseEnabled) {
      throw new Error("播出音乐音频尚未就绪");
    }
    const child = this.#spawn("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "warning",
      "-f", "pulse", "-i", `${MUSIC_SINK}.monitor`,
      "-vn", "-c:a", "libopus", "-b:a", "160k", "-ar", "48000",
      "-ac", "2", "-application", "audio", "-f", "ogg", "pipe:1",
    ], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    this.#audioClients.set(response, child);
    response.writeHead(200, {
      "Content-Type": "audio/ogg; codecs=opus",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      Connection: "close",
      "X-Content-Type-Options": "nosniff",
    });
    response.flushHeaders();
    child.stdout?.pipe(response);
    const finish = () => {
      if (this.#audioClients.get(response) !== child) return;
      this.#audioClients.delete(response);
      child.stdout?.unpipe(response);
      if (!response.writableEnded) response.end();
    };
    response.once("close", () => {
      stopProcessGroup(child);
      finish();
    });
    child.once("error", finish);
    child.once("exit", finish);
  }

  async close(): Promise<void> {
    this.#generation += 1;
    if (this.#playRetry) clearTimeout(this.#playRetry);
    this.#playRetry = null;
    this.#danmaku?.close();
    this.#danmaku = null;
    if (this.#player) stopProcessGroup(this.#player);
    this.#player = null;
    for (const [response, child] of this.#audioClients) {
      stopProcessGroup(child);
      response.end();
    }
    this.#audioClients.clear();
    await this.#provider?.close().catch(() => undefined);
    this.#provider = null;
    await this.#removeSink();
    this.#phase = "disabled";
    this.#providerState = "stopped";
    this.#audioState = "stopped";
  }

  async #reconcile(restart: boolean): Promise<void> {
    if (!this.#configuration.enabled) {
      if (restart || this.#provider || this.#danmaku || this.#sinkModuleId) {
        await this.#stopRuntime();
      }
      this.#phase = "disabled";
      this.#error = null;
      this.#notify();
      return;
    }
    if (!restart && this.#provider && this.#sinkModuleId && this.#phase === "ready") {
      this.#notify();
      return;
    }
    await this.#stopRuntime();
    const generation = ++this.#generation;
    this.#phase = "starting";
    this.#error = null;
    this.#notify();
    try {
      this.#provider = this.#providerFactory(this.#configuration);
      await this.#provider.start();
      if (generation !== this.#generation) return;
      this.#providerState = "ready";
      if (this.#pulseEnabled) {
        await this.#createSink();
        await this.#setSinkVolume();
      } else {
        this.#sinkModuleId = "test";
      }
      this.#audioState = "ready";
      this.#phase = "ready";
      this.#notify();
      void this.#playNext(generation);

      this.#danmakuState = {
        phase: "idle", roomId: null, reconnectAttempt: 0, error: null,
      };
      this.#danmaku = this.#danmakuFactory(this.#configuration, {
        onComment: (text, userName) => {
          if (generation === this.#generation) this.#handleComment(text, userName);
        },
        onState: (state) => {
          if (generation !== this.#generation) return;
          this.#danmakuState = state;
          this.#notify();
        },
        onError: (error) => {
          if (generation !== this.#generation) return;
          this.#danmakuState = {
            ...this.#danmakuState,
            error: safeError(error),
          };
          this.#notify();
        },
      });
      void this.#danmaku.start().catch((error) => {
        if (generation !== this.#generation) return;
        this.#danmakuState = {
          ...this.#danmakuState,
          phase: "reconnecting",
          error: safeError(error),
        };
        this.#notify();
      });
    } catch (error) {
      this.#phase = "error";
      this.#providerState = this.#provider ? "error" : "stopped";
      this.#audioState = "error";
      this.#error = safeError(error);
      this.#notify();
    }
  }

  async #stopRuntime(): Promise<void> {
    this.#generation += 1;
    if (this.#playRetry) clearTimeout(this.#playRetry);
    this.#playRetry = null;
    this.#danmaku?.close();
    this.#danmaku = null;
    this.#danmakuState = { phase: "closed", roomId: null, reconnectAttempt: 0, error: null };
    if (this.#player) stopProcessGroup(this.#player);
    this.#player = null;
    this.#current = null;
    await this.#provider?.close().catch(() => undefined);
    this.#provider = null;
    this.#providerState = "stopped";
    for (const [response, child] of this.#audioClients) {
      stopProcessGroup(child);
      response.end();
    }
    this.#audioClients.clear();
    await this.#removeSink();
    this.#audioState = "stopped";
  }

  #handleComment(text: string, userName: string): void {
    this.#lastCommentAt = new Date().toISOString();
    this.#notify();
    const query = parseMusicRequest(text, this.#configuration.requestPrefix);
    if (!query) return;
    void this.requestSong(query, userName).catch((error) => {
      this.#error = safeError(error);
      this.#notify();
    });
  }

  async #playNext(generation: number): Promise<void> {
    if (generation !== this.#generation || this.#player || this.#current || !this.#provider) return;
    let item = this.#queue.shift() ?? null;
    if (item) {
      this.#queueChangedAt = new Date().toISOString();
      this.#notify();
    } else if (this.#configuration.dailyRecommendations) {
      const track = await this.#nextRecommendation().catch((error) => {
        this.#error = safeError(error);
        this.#notify();
        return null;
      });
      if (track) {
        item = {
          track,
          requestedBy: "每日推荐",
          requestedAt: new Date().toISOString(),
          recommendation: true,
        };
      }
    }
    if (!item || generation !== this.#generation) {
      if (generation === this.#generation && this.#configuration.dailyRecommendations) {
        this.#schedulePlayNext(generation, this.#retryDelayMs);
      }
      return;
    }
    let prepared: PreparedMusicTrack;
    try {
      prepared = await this.#provider.prepareTrack(item.track);
    } catch (firstError) {
      if (!this.#configuration.vipAutoClaim) {
        this.#error = safeError(firstError);
        this.#schedulePlayNext(generation, this.#retryDelayMs);
        return;
      }
      try {
        await this.#claimVipOnceToday();
        prepared = await this.#provider.prepareTrack(item.track);
      } catch (secondError) {
        this.#error = safeError(secondError);
        this.#schedulePlayNext(generation, this.#retryDelayMs);
        return;
      }
    }
    if (generation !== this.#generation) return;
    this.#current = {
      ...item,
      startedAt: new Date().toISOString(),
      lyrics: prepared.lyrics.slice(0, 1_000),
    };
    this.#recent.add(item.track.id);
    while (this.#recent.size > 30) this.#recent.delete(this.#recent.values().next().value as string);
    this.#error = null;
    this.#audioState = "playing";
    this.#notify();
    if (!this.#pulseEnabled) return;
    const child = this.#spawn("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "warning",
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
      "-i", prepared.url, "-vn", "-af", "aresample=48000",
      "-ac", "2", "-ar", "48000", "-f", "pulse",
      "-device", MUSIC_SINK, "-stream_name", "Astra Broadcast Music",
      "music",
    ], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
    this.#player = child;
    const finished = () => {
      if (this.#player !== child) return;
      this.#player = null;
      this.#current = null;
      this.#audioState = this.#sinkModuleId ? "ready" : "stopped";
      this.#notify();
      this.#schedulePlayNext(generation, 250);
    };
    child.once("error", finished);
    child.once("exit", finished);
  }

  #schedulePlayNext(generation: number, delayMs: number): void {
    if (generation !== this.#generation || this.#playRetry) return;
    this.#playRetry = setTimeout(() => {
      this.#playRetry = null;
      void this.#playNext(generation);
    }, delayMs);
    this.#playRetry.unref();
  }

  async #nextRecommendation(): Promise<MusicTrack | null> {
    if (!this.#provider) return null;
    if (this.#recommendations.length === 0) {
      this.#recommendations = await this.#provider.dailyRecommendations(
        this.#configuration.recommendationCardId,
      );
    }
    const available = this.#recommendations.filter((track) => !this.#recent.has(track.id));
    const pool = available.length > 0 ? available : this.#recommendations;
    if (pool.length === 0) return null;
    const index = Math.min(pool.length - 1, Math.floor(this.#random() * pool.length));
    const selected = pool[index] ?? null;
    if (selected) {
      this.#recommendations = this.#recommendations.filter((track) => track.id !== selected.id);
    }
    return selected;
  }

  async #claimVipOnceToday(): Promise<VipClaimResult & { at: string }> {
    const today = shanghaiDate(new Date());
    if (this.#lastVipClaim && shanghaiDate(new Date(this.#lastVipClaim.at)) === today) {
      return { ...this.#lastVipClaim };
    }
    return await this.claimVip();
  }

  #hasTrack(id: string): boolean {
    return this.#current?.track.id === id || this.#queue.some((item) => item.track.id === id);
  }

  async #createSink(): Promise<void> {
    await cleanupMusicSink();
    const result = await runCommand("pactl", [
      "load-module", "module-null-sink", `sink_name=${MUSIC_SINK}`,
      "sink_properties=device.description=\"Astra Broadcast Music\" device.class=\"abstract\"",
      "format=s16le", "rate=48000", "channels=2", "channel_map=front-left,front-right",
    ], { timeoutMs: 5_000 });
    const id = result.stdout.toString("utf8").trim();
    if (result.code !== 0 || !/^\d+$/.test(id)) {
      throw new Error(result.stderr.toString("utf8").trim() || "无法创建播出音乐音频节点");
    }
    this.#sinkModuleId = id;
  }

  async #setSinkVolume(): Promise<void> {
    if (!this.#sinkModuleId || !this.#pulseEnabled) return;
    await runCommand("pactl", [
      "set-sink-volume", MUSIC_SINK,
      `${Math.round(this.#configuration.musicVolume * 100)}%`,
    ], { timeoutMs: 5_000 });
  }

  async #removeSink(): Promise<void> {
    const id = this.#sinkModuleId;
    this.#sinkModuleId = null;
    if (id && id !== "test") {
      await runCommand("pactl", ["unload-module", id], { timeoutMs: 5_000 })
        .catch(() => undefined);
    }
  }

  #notify(): void {
    try { this.#onChange(this.snapshot); } catch { /* observers are isolated */ }
  }
}

export function parseMusicRequest(text: string, prefix: string): string | null {
  const trimmed = text.trim();
  const command = prefix.trim();
  if (!command || !trimmed.startsWith(command)) return null;
  const query = trimmed.slice(command.length).replace(/^[\s:：,，]+/, "").trim();
  return query.length > 0 ? query : null;
}

export async function cleanupMusicSink(): Promise<void> {
  const result = await runCommand("pactl", ["list", "short", "modules"], {
    timeoutMs: 5_000,
  }).catch(() => null);
  if (!result || result.code !== 0) return;
  const ids = result.stdout.toString("utf8").split(/\r?\n/).flatMap((line) =>
    line.includes(MUSIC_SINK) ? [/^\s*(\d+)\b/.exec(line)?.[1]].filter(Boolean) as string[] : []
  );
  for (const id of [...new Set(ids)].reverse()) {
    await runCommand("pactl", ["unload-module", id], { timeoutMs: 5_000 })
      .catch(() => undefined);
  }
}

function defaultProviderFactory(configuration: MusicConfiguration): MusicProvider {
  return new MoeKoeProvider({
    baseUrl: configuration.providerBaseUrl,
    apiBinaryPath: configuration.providerBinary,
    profileDirectory: configuration.profileDirectory,
    manageProcess: configuration.provider === "moekoe",
    port: portFromUrl(configuration.providerBaseUrl),
  });
}

function defaultDanmakuFactory(
  configuration: MusicConfiguration,
  callbacks: {
    onComment: (text: string, userName: string) => void;
    onState: (state: BilibiliDanmakuState) => void;
    onError: (error: Error) => void;
  },
): BilibiliDanmakuClient {
  return new BilibiliDanmakuClient({
    roomId: configuration.roomId,
    onComment: (comment) => callbacks.onComment(comment.text, comment.userName),
    onState: callbacks.onState,
    onError: callbacks.onError,
  });
}

function portFromUrl(value: string): number {
  const url = new URL(value);
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

function operationalKey(configuration: MusicConfiguration): string {
  return JSON.stringify({
    enabled: configuration.enabled,
    roomId: configuration.roomId,
    provider: configuration.provider,
    providerBaseUrl: configuration.providerBaseUrl,
    providerBinary: configuration.providerBinary,
    profileDirectory: configuration.profileDirectory,
  });
}

function cloneQueued(item: QueuedMusicTrack): QueuedMusicTrack {
  return { ...item, track: { ...item.track } };
}

function cloneCurrent(item: CurrentMusicTrack): CurrentMusicTrack {
  return {
    ...cloneQueued(item),
    startedAt: item.startedAt,
    lyrics: item.lyrics.map((line) => ({
      ...line,
      words: line.words.map((word) => ({ ...word })),
    })),
  };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(token|authorization|key)=[^;\s&]+/gi, "$1=[redacted]").slice(0, 500);
}

function processRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function stopProcessGroup(child: ChildProcess): void {
  if (!processRunning(child) || !child.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  const forced = setTimeout(() => {
    if (!processRunning(child) || !child.pid) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }, 1_000);
  forced.unref();
  child.once("exit", () => clearTimeout(forced));
}

function shanghaiDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(value);
}
