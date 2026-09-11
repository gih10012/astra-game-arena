import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import {
  createServer,
  get as httpGet,
  type ClientRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AccountPool,
  discoverCodexAccounts,
  type AccountPoolState,
  type AccountUsageState,
  type RateWindowState,
} from "./account-pool.js";
import { runCommand } from "./command.js";
import {
  CHATGPT_POOL_CREDENTIAL,
  credentialAfterModelChange,
} from "./codex-home.js";
import {
  CheckpointStore,
  clearActiveRun,
  durableJsonWrite,
  isTerminal,
  processMatches,
  readActiveRun,
  registerActiveRun,
  type AccountPolicy,
  type RunCheckpoint,
} from "./run-checkpoint.js";
import {
  readRuntimeConfigAck,
  readRuntimeMediaState,
  writeRuntimeControlState,
  writeRuntimeConfigRequest,
  type MutableRuntimeConfiguration,
  type RuntimeConfigAck,
  type RuntimeMediaState,
} from "./runtime-config.js";
import {
  cancelChallenge,
  currentCredentialStatus,
  queueChallenge,
} from "./runner.js";
import { runWorkerIsActive, stopRunWorker } from "./run-worker.js";
import { cleanupPrivateGameAudio } from "./private-audio.js";
import { discoverInstalledSteamGames } from "./steam-catalog.js";
import {
  discoverVirtualCameraDevices,
  virtualCameraBrowserStreamArguments,
} from "./virtual-camera.js";
import {
  determineBroadcastPlayback,
  discoverBroadcastMedia,
  probeBroadcastMedia,
  readBroadcastConfiguration,
  replayAudioFfmpegArguments,
  replayFfmpegArguments,
  replayMjpegFfmpegArguments,
  selectedBroadcastMedia,
  validateManualBroadcastFile,
  writeBroadcastConfiguration,
  type BroadcastConfiguration,
  type BroadcastMediaItem,
} from "./broadcast.js";
import { MusicService } from "./music-service.js";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  import.meta.url.includes("/dist/") ? "../../web" : "../web",
);
const OPERATOR_CONFIG_FILENAME = "operator-config.json";

interface OperatorConfiguration {
  version: 1;
  updatedAt: string;
  gameAppId: string;
  goal: string;
  gpuPreference: "auto" | "integrated" | "discrete";
  launchMode: "steam-online" | "steam-offline" | "direct";
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  record: boolean;
  virtualCamera: boolean;
  virtualCameraDevice: string;
  quotaWaitMs: number;
  accountPolicies: AccountPolicy[];
  webSearchEnabled: boolean;
  browserUseEnabled: boolean;
  toolCreationGuidance: boolean;
}

interface TranscriptRecord {
  sequence: number;
  at: string;
  event: unknown;
}

interface ModelOption {
  slug: string;
  displayName: string;
  description: string;
  reasoningEfforts: string[];
  defaultReasoningEffort: string;
}

interface PublicBroadcastMediaItem {
  id: string;
  name: string;
  displayPath: string;
  source: BroadcastMediaItem["source"];
  bytes: number;
  modifiedAt: string;
  durationSeconds?: number | null;
  hasAudio?: boolean;
}

interface BroadcastSnapshot {
  configuration: Omit<BroadcastConfiguration, "playlist" | "manualFiles"> & {
    playlist: string[];
    manualFileCount: number;
  };
  library?: PublicBroadcastMediaItem[];
  selected: PublicBroadcastMediaItem[];
  playback: {
    mode: "live" | "replay" | "standby";
    reason: string;
    phase: RunCheckpoint["phase"] | null;
    liveAvailable: boolean;
    retryAt: string | null;
  };
  liveUrl: string;
  resolution: { width: number; height: number };
}

export class ControlPlane {
  readonly rootDirectory: string;
  readonly host: string;
  readonly port: number;
  #server: Server | null = null;
  #refreshTimer: NodeJS.Timeout | null = null;
  #refreshing = false;
  #snapshot: unknown = emptySnapshot();
  #checkpoint: RunCheckpoint | null = null;
  #transcript: TranscriptRecord[] = [];
  #frame: { data: Buffer; type: string; etag: string } | null = null;
  #clients = new Set<ServerResponse>();
  #livePreviews = new Map<ServerResponse, ChildProcess>();
  #liveProxies = new Map<ServerResponse, ClientRequest>();
  #replayStreams = new Map<ServerResponse, ChildProcess>();
  #lastStateJson = "";
  #lastTranscriptKey = "";
  #lastFrameEtag = "";
  #options: Awaited<ReturnType<typeof loadOptions>> | null = null;
  #configurationUpdates: Promise<void> = Promise.resolve();
  #pendingConfigurationIds = new Map<string, string>();
  #lastOperatorConfigurationKey = "";
  #music: MusicService | null = null;

  constructor(rootDirectory: string, options: { host?: string; port?: number } = {}) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 4317;
  }

  get url(): string {
    if (!this.#server) throw new Error("Control plane is not listening");
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("Control plane address unavailable");
    return `http://${this.host}:${address.port}`;
  }

  async listen(): Promise<string> {
    if (this.#server) return this.url;
    this.#music = await MusicService.open(this.rootDirectory, (snapshot) => {
      this.#broadcast("music", snapshot);
    });
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : 500;
        json(response, status, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.#server?.once("error", reject);
      this.#server?.listen(this.port, this.host, resolve);
    });
    await this.refresh();
    void this.#music.activate();
    this.#refreshTimer = setInterval(() => void this.refresh(), 500);
    this.#refreshTimer.unref();
    return this.url;
  }

  async close(): Promise<void> {
    if (this.#refreshTimer) clearInterval(this.#refreshTimer);
    this.#refreshTimer = null;
    for (const client of this.#clients) client.end();
    this.#clients.clear();
    for (const [client, process] of this.#livePreviews) {
      stopLivePreview(process);
      client.end();
    }
    this.#livePreviews.clear();
    for (const [client, upstream] of this.#liveProxies) {
      upstream.destroy();
      client.end();
    }
    this.#liveProxies.clear();
    for (const [client, process] of this.#replayStreams) {
      stopLivePreview(process);
      client.end();
    }
    this.#replayStreams.clear();
    await this.#music?.close();
    this.#music = null;
    if (!this.#server) return;
    const server = this.#server;
    this.#server = null;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve();
      };
      const deadline = setTimeout(finish, 2_000);
      server.close(finish);
      server.closeAllConnections();
    });
  }

  async refresh(): Promise<void> {
    if (this.#refreshing) return;
    this.#refreshing = true;
    try {
      const runDirectory = await readActiveRun(this.rootDirectory);
      if (!runDirectory) {
        this.#checkpoint = null;
        this.#snapshot = emptySnapshot();
        this.#transcript = [];
        this.#frame = null;
        this.#broadcastChanges();
        return;
      }
      const checkpoint = (await CheckpointStore.load(runDirectory)).snapshot();
      this.#checkpoint = checkpoint;
      await this.#syncOperatorConfiguration(checkpoint);
      await this.#broadcastPendingConfigurationAcks(runDirectory);
      const internalPort = checkpoint.options.port;
      const canProxy = internalPort !== this.port &&
        checkpoint.pid !== null &&
        processMatches(checkpoint.pid, checkpoint.pidStartTicks);
      if (canProxy) {
        const base = `http://127.0.0.1:${internalPort}`;
        const [snapshot, transcript, frame] = await Promise.all([
          fetchJson(`${base}/api/challenge`),
          fetchJson(`${base}/api/transcript`),
          fetchBuffer(`${base}/api/frame`),
        ]);
        if (snapshot) this.#snapshot = snapshot;
        else this.#snapshot = checkpointSnapshot(checkpoint);
        if (Array.isArray(transcript)) this.#transcript = transcript as TranscriptRecord[];
        if (frame) this.#frame = frame;
      } else {
        this.#snapshot = checkpointSnapshot(checkpoint);
        this.#transcript = await persistedTranscript(checkpoint);
        this.#frame = await lastRuntimeFrame(checkpoint);
      }
      this.#broadcastChanges();
    } catch (error) {
      this.#broadcast("supervisor", {
        type: "supervisor.warning",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.#refreshing = false;
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${this.host}`);
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { ok: true, service: "astra-game-arena" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/options") {
      this.#options = await loadOptions();
      const operator = await readOperatorConfiguration(this.rootDirectory);
      const configured = this.#checkpoint?.options;
      const defaults = configurationDefaults(
        configured,
        operator,
        this.#options.virtualCameras[0]?.device ?? "/dev/video10",
      );
      json(response, 200, {
        ...this.#options,
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaults,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      const checkpoint = this.#checkpoint;
      const [accountPool, virtualCameras, operatorConfiguration, mediaState, broadcast] = await Promise.all([
        accountPoolSnapshot(checkpoint),
        discoverVirtualCameraDevices(),
        readOperatorConfiguration(this.rootDirectory),
        checkpoint ? readRuntimeMediaState(checkpoint.runDirectory) : null,
        this.#broadcastSnapshot(false),
      ]);
      json(response, 200, { ...statusSnapshot({
        rootDirectory: this.rootDirectory,
        host: this.host,
        port: this.port,
        checkpoint,
        challenge: this.#snapshot,
        accountPool,
        virtualCameras,
        operatorConfiguration,
        mediaState,
      }), broadcast, music: this.#music?.snapshot ?? null });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/supervisor") {
      const checkpoint = this.#checkpoint;
      const [accountPool, mediaState] = await Promise.all([
        accountPoolSnapshot(checkpoint),
        checkpoint ? readRuntimeMediaState(checkpoint.runDirectory) : null,
      ]);
      const publicAccountPool = supervisorAccountPool(checkpoint, accountPool);
      json(response, 200, {
        active: checkpoint !== null,
        checkpoint,
        currentCredential: checkpoint
          ? currentCredentialStatus(checkpoint.credential, publicAccountPool)
          : null,
        accountPool: publicAccountPool,
        recording: recordingStatus(checkpoint, mediaState),
        virtualCamera: virtualCameraStatus(checkpoint, mediaState),
        virtualMicrophone: virtualMicrophoneStatus(checkpoint, mediaState),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/challenge") {
      json(response, 200, this.#snapshot);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/challenge/time") {
      json(response, 200, objectValue(this.#snapshot)?.time ?? emptySnapshot().time);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/challenge/tokens") {
      json(response, 200, objectValue(this.#snapshot)?.tokens ?? emptySnapshot().tokens);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/transcript") {
      json(response, 200, this.#transcript);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/frame") {
      if (!this.#frame) {
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
      } else {
        response.writeHead(200, {
          "Content-Type": this.#frame.type,
          "Cache-Control": "no-store",
          ETag: this.#frame.etag,
        });
        response.end(this.#frame.data);
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/live.mjpeg") {
      const checkpoint = this.#checkpoint;
      if (hasLiveRunner(checkpoint)) {
        const address = this.#server?.address();
        if (typeof address === "object" && address?.port === checkpoint.options.port) {
          throw new HttpError(502, "The private runner stream points to the control-plane port");
        }
        this.#startRunnerProxy(
          response,
          checkpoint.options.port,
          "/api/live.mjpeg",
          "multipart/x-mixed-replace; boundary=ffmpeg",
          "private game live stream",
        );
        return;
      }
      const mediaState = checkpoint
        ? await readRuntimeMediaState(checkpoint.runDirectory)
        : null;
      const camera = virtualCameraStatus(checkpoint, mediaState);
      if (!camera.active || !camera.device) {
        throw new HttpError(409, "Live preview is available while the virtual camera is active");
      }
      this.#startLivePreview(response, camera.device);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/live-audio.ogg") {
      const checkpoint = this.#checkpoint;
      if (!hasLiveRunner(checkpoint) || checkpoint?.phase !== "running") {
        throw new HttpError(409, "Live game audio is available while a challenge is running");
      }
      this.#startRunnerProxy(
        response,
        checkpoint.options.port,
        "/api/live-audio.ogg",
        "audio/ogg; codecs=opus",
        "private game audio stream",
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/music") {
      json(response, 200, this.#requiredMusic().snapshot);
      return;
    }
    if (request.method === "PATCH" && url.pathname === "/api/music") {
      const snapshot = await this.#requiredMusic().update(await readJson(request));
      this.#broadcast("music", snapshot);
      json(response, 200, snapshot);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/music/request") {
      const body = await readJson(request);
      const item = await this.#requiredMusic().requestSong(
        String(body.query ?? ""),
        String(body.requestedBy ?? "控制台"),
      );
      json(response, 201, { accepted: true, item, music: this.#requiredMusic().snapshot });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/music/skip") {
      await this.#requiredMusic().skip();
      json(response, 202, { accepted: true, music: this.#requiredMusic().snapshot });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/music/vip") {
      const result = await this.#requiredMusic().claimVip();
      json(response, 200, { result, music: this.#requiredMusic().snapshot });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/music/audio.ogg") {
      const music = this.#requiredMusic();
      if (!music.snapshot.configuration.enabled || music.snapshot.runtime.audio === "stopped") {
        throw new HttpError(409, "Broadcast music audio is not enabled");
      }
      music.startAudioStream(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/broadcast") {
      json(response, 200, await this.#broadcastSnapshot(true));
      return;
    }
    if (request.method === "PATCH" && url.pathname === "/api/broadcast") {
      const body = await readJson(request);
      const snapshot = await this.#serializeConfigurationUpdate(async () => {
        const current = await readBroadcastConfiguration(this.rootDirectory);
        const library = await discoverBroadcastMedia(this.rootDirectory, current.manualFiles);
        const configuration = broadcastConfigurationPatch(current, body, library);
        await writeBroadcastConfiguration(this.rootDirectory, configuration);
        return await this.#broadcastSnapshot(true);
      });
      this.#broadcast("broadcast", snapshot);
      json(response, 200, snapshot);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/broadcast/media") {
      const body = await readJson(request);
      const filename = await validateManualBroadcastFile(String(body.path ?? ""));
      const snapshot = await this.#serializeConfigurationUpdate(async () => {
        const current = await readBroadcastConfiguration(this.rootDirectory);
        const manualFiles = [...new Set([...current.manualFiles, filename])];
        const playlist = body.select === false
          ? current.playlist
          : [...new Set([...current.playlist, filename])];
        await writeBroadcastConfiguration(this.rootDirectory, {
          ...current,
          manualFiles,
          playlist,
        });
        return await this.#broadcastSnapshot(true);
      });
      this.#broadcast("broadcast", snapshot);
      json(response, 201, snapshot);
      return;
    }
    if (request.method === "DELETE" && url.pathname === "/api/broadcast/media") {
      const id = url.searchParams.get("id") ?? "";
      const snapshot = await this.#serializeConfigurationUpdate(async () => {
        const current = await readBroadcastConfiguration(this.rootDirectory);
        const library = await discoverBroadcastMedia(this.rootDirectory, current.manualFiles);
        const item = library.find((entry) => entry.id === id && entry.source === "manual");
        if (!item) throw new HttpError(404, "Manual replay path is unavailable");
        await writeBroadcastConfiguration(this.rootDirectory, {
          ...current,
          manualFiles: current.manualFiles.filter((filename) => path.resolve(filename) !== item.filename),
          playlist: current.playlist.filter((filename) => filename !== item.filename),
        });
        return await this.#broadcastSnapshot(true);
      });
      this.#broadcast("broadcast", snapshot);
      json(response, 200, snapshot);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/broadcast/replay") {
      const configuration = await readBroadcastConfiguration(this.rootDirectory);
      const library = await discoverBroadcastMedia(this.rootDirectory, configuration.manualFiles);
      const selected = selectedBroadcastMedia(configuration, library);
      const item = selected.find((entry) => entry.id === url.searchParams.get("id"));
      if (!item) throw new HttpError(404, "Replay media is not in the active playlist");
      this.#startReplay(response, item);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/broadcast/replay.mjpeg") {
      const item = await this.#selectedReplayItem(url.searchParams.get("id"));
      const accountPool = await accountPoolSnapshot(this.#checkpoint);
      const publicAccountPool = supervisorAccountPool(this.#checkpoint, accountPool);
      const credentialLabel = this.#checkpoint
        ? currentCredentialStatus(this.#checkpoint.credential, publicAccountPool).label
        : "ChatGPT account";
      this.#startReplayStream(
        response,
        item,
        replayMjpegFfmpegArguments(item.filename, credentialLabel),
        "multipart/x-mixed-replace; boundary=ffmpeg",
        "Replay video",
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/broadcast/replay-audio.ogg") {
      const item = await this.#selectedReplayItem(url.searchParams.get("id"));
      if (!(await probeBroadcastMedia(item)).hasAudio) {
        throw new HttpError(409, "Replay media has no audio stream");
      }
      this.#startReplayStream(
        response,
        item,
        replayAudioFfmpegArguments(item.filename),
        "audio/ogg; codecs=opus",
        "Replay audio",
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      response.write(`event: state\ndata: ${JSON.stringify(this.#snapshot)}\n\n`);
      response.write(`event: broadcast\ndata: ${JSON.stringify(await this.#broadcastSnapshot(false))}\n\n`);
      response.write(`event: music\ndata: ${JSON.stringify(this.#music?.snapshot ?? null)}\n\n`);
      this.#clients.add(response);
      request.on("close", () => this.#clients.delete(response));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/control/start") {
      const body = await readJson(request);
      const options = await loadOptions();
      const gameAppId = String(body.gameAppId ?? "1260520");
      if (!options.games.some((entry) => objectValue(entry)?.appId === gameAppId)) {
        throw new HttpError(400, "Selected Steam game is unavailable");
      }
      const model = String(body.model ?? "gpt-6-astra");
      if (!options.models.some((entry) => entry.slug === model)) {
        throw new HttpError(400, "Selected model is unavailable");
      }
      const goal = String(body.goal ?? "").trim();
      if (goal.length < 3 || goal.length > 4_000) {
        throw new HttpError(400, "Goal must contain 3 to 4000 characters");
      }
      const reasoningEffort = parseReasoning(body.reasoningEffort);
      const gpuPreference = parseGpuPreference(body.gpuPreference);
      const launchMode = parseLaunchMode(body.launchMode, body.offlineMode);
      const accountPolicies = parseAccountPolicies(body.accountPolicies, options.accounts);
      const virtualCamera = body.virtualCamera === true;
      const webSearchEnabled = body.webSearchEnabled === true;
      const browserUseEnabled = body.browserUseEnabled === true;
      const toolCreationGuidance = body.toolCreationGuidance === true;
      const virtualCameraDevice = String(
        body.virtualCameraDevice ?? options.virtualCameras[0]?.device ?? "/dev/video10",
      );
      if (
        virtualCamera &&
        !options.virtualCameras.some((entry) =>
          entry.device === virtualCameraDevice && entry.writable
        )
      ) {
        throw new HttpError(
          400,
          `Virtual camera ${virtualCameraDevice} is unavailable or not writable`,
        );
      }
      const currentDirectory = await readActiveRun(this.rootDirectory);
      if (currentDirectory) {
        const current = (await CheckpointStore.load(currentDirectory)).snapshot();
        if (!isTerminal(current.phase)) {
          throw new HttpError(409, `A challenge is already ${current.phase}`);
        }
        await clearActiveRun(this.rootDirectory, currentDirectory);
      }
      const outcome = await queueChallenge({
        rootDirectory: this.rootDirectory,
        publicPort: this.port,
        port: 4318,
        gameAppId,
        model,
        goal,
        gpuPreference,
        launchMode,
        offlineMode: launchMode === "direct",
        reasoningEffort,
        record: body.record !== false,
        virtualCamera,
        virtualCameraDevice,
        openDashboard: false,
        accountPolicies,
        webSearchEnabled,
        browserUseEnabled,
        toolCreationGuidance,
      });
      await writeOperatorConfiguration(this.rootDirectory, {
        version: 1,
        updatedAt: new Date().toISOString(),
        gameAppId,
        goal,
        gpuPreference,
        launchMode,
        model,
        reasoningEffort,
        record: body.record !== false,
        virtualCamera,
        virtualCameraDevice,
        quotaWaitMs: 5 * 60 * 60_000,
        accountPolicies,
        webSearchEnabled,
        browserUseEnabled,
        toolCreationGuidance,
      });
      await this.refresh();
      json(response, 202, outcome);
      return;
    }
    if (request.method === "PATCH" && url.pathname === "/api/configuration") {
      const body = await readJson(request);
      const result = await this.#serializeConfigurationUpdate(async () => {
        const checkpoint = await requiredCheckpoint(this.rootDirectory);
        if (isTerminal(checkpoint.phase)) {
          throw new HttpError(409, "The active challenge has already ended");
        }
        const options = await loadOptions();
        const patch = parseMutableConfiguration(body, checkpoint, options);
        let acknowledgement: RuntimeConfigAck;

        if (hasLiveRunner(checkpoint)) {
          const requestId = randomUUID();
          await writeRuntimeConfigRequest(checkpoint.runDirectory, {
            version: 1,
            id: requestId,
            requestedAt: new Date().toISOString(),
            patch,
          });
          const runnerAck = await waitForRuntimeConfigAck(
            checkpoint.runDirectory,
            requestId,
            2_500,
          );
          if (!runnerAck) {
            this.#pendingConfigurationIds.set(requestId, checkpoint.runDirectory);
            await this.refresh();
            const pending = { id: requestId, pending: true };
            this.#broadcast("configuration", pending);
            return {
              status: 202,
              body: {
                accepted: true,
                pending: true,
                requestId,
                configuration: configurationStatus(
                  this.#checkpoint,
                  this.rootDirectory,
                  this.port,
                  options.virtualCameras[0]?.device ?? "/dev/video10",
                ),
                acknowledgement: null,
              },
            };
          }
          acknowledgement = runnerAck;
          if (acknowledgement.error) {
            await this.refresh();
            this.#broadcast("configuration", acknowledgement);
            return {
              status: 409,
              body: {
                error: acknowledgement.error,
                accepted: false,
                pending: false,
                configuration: configurationStatus(
                  this.#checkpoint,
                  this.rootDirectory,
                  this.port,
                  options.virtualCameras[0]?.device ?? "/dev/video10",
                ),
                acknowledgement,
              },
            };
          }
        } else {
          const store = await CheckpointStore.load(checkpoint.runDirectory);
          await store.update((current) => ({
            options: { ...current.options, ...patch },
            ...(patch.model !== undefined && patch.model !== current.options.model
              ? {
                  credential: credentialAfterModelChange(
                    current.credential ?? CHATGPT_POOL_CREDENTIAL,
                    current.options.model,
                    patch.model,
                  ),
                }
              : {}),
          }));
          // A watchdog may start a waiting run between this read and write.
          // Leave the same idempotent patch in the runner queue so a process
          // that captured the previous checkpoint cannot overwrite it later.
          if (checkpoint.phase !== "paused") {
            await writeRuntimeConfigRequest(checkpoint.runDirectory, {
              version: 1,
              id: randomUUID(),
              requestedAt: new Date().toISOString(),
              patch,
            });
          }
          if (patch.accountPolicies) {
            const profiles = await discoverCodexAccounts();
            await AccountPool.open(
              checkpoint.runDirectory,
              profiles,
              patch.accountPolicies,
            );
          }
          acknowledgement = {
            version: 1,
            id: randomUUID(),
            appliedAt: new Date().toISOString(),
            appliedFields: Object.keys(patch),
            deferredFields: [],
            codexRestarted: false,
            error: null,
          };
        }

        const appliedCheckpoint = (await CheckpointStore.load(checkpoint.runDirectory)).snapshot();
        await writeOperatorConfiguration(
          this.rootDirectory,
          operatorConfigurationFromCheckpoint(appliedCheckpoint),
        );
        await this.refresh();
        this.#broadcast("configuration", acknowledgement);
        return {
          status: acknowledgement.appliedFields.length > 0 ? 200 : 202,
          body: {
            accepted: true,
            pending: false,
            configuration: configurationStatus(
              this.#checkpoint,
              this.rootDirectory,
              this.port,
              options.virtualCameras[0]?.device ?? "/dev/video10",
            ),
            acknowledgement,
          },
        };
      });
      json(response, result.status, result.body);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/control/pause") {
      const checkpoint = await requiredCheckpoint(this.rootDirectory);
      if (checkpoint.phase === "paused") {
        json(response, 202, { accepted: true, action: "pause", alreadyPaused: true });
        return;
      }
      if (checkpoint.pid !== null && processMatches(checkpoint.pid, checkpoint.pidStartTicks)) {
        await writeRuntimeControlState(checkpoint.runDirectory, true);
        process.kill(checkpoint.pid, "SIGUSR1");
      } else if (await runWorkerIsActive(checkpoint.runId)) {
        await writeRuntimeControlState(checkpoint.runDirectory, true);
      } else {
        await writeRuntimeControlState(checkpoint.runDirectory, true);
        await (await CheckpointStore.load(checkpoint.runDirectory)).update({
          phase: "paused", pid: null, pidStartTicks: null, retryAt: null,
          gameRuntimeReady: false, gameRuntimeFrozen: false,
          reason: "Exact in-memory runtime is unavailable; automatic relaunch is disabled",
        });
      }
      json(response, 202, { accepted: true, action: "pause" });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/control/resume") {
      const checkpoint = await requiredCheckpoint(this.rootDirectory);
      if (checkpoint.phase !== "paused") throw new HttpError(409, "Challenge is not paused");
      if (
        checkpoint.pid === null ||
        !processMatches(checkpoint.pid, checkpoint.pidStartTicks)
      ) {
        if (checkpoint.attempt === 0 && !(await runWorkerIsActive(checkpoint.runId))) {
          await writeRuntimeControlState(checkpoint.runDirectory, false);
          await (await CheckpointStore.load(checkpoint.runDirectory)).update({
            phase: "waiting_retry",
            retryAt: new Date().toISOString(),
            reason: "Queued challenge resumed before its game runtime started",
          });
          await registerActiveRun(this.rootDirectory, checkpoint.runDirectory);
          json(response, 202, { accepted: true, action: "resume" });
          return;
        }
        throw new HttpError(
          409,
          "Exact in-memory runtime is unavailable; refusing to relaunch the game",
        );
      }
      await writeRuntimeControlState(checkpoint.runDirectory, false);
      process.kill(checkpoint.pid, "SIGUSR2");
      json(response, 202, { accepted: true, action: "resume" });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/control/end") {
      const checkpoint = await requiredCheckpoint(this.rootDirectory);
      void stopAndCancel(checkpoint);
      json(response, 202, { accepted: true, action: "end" });
      return;
    }

    const staticFiles: Record<string, { name: string; type: string }> = {
      "/": { name: "index.html", type: "text/html; charset=utf-8" },
      "/control": { name: "index.html", type: "text/html; charset=utf-8" },
      "/control/": { name: "index.html", type: "text/html; charset=utf-8" },
      "/live": { name: "index.html", type: "text/html; charset=utf-8" },
      "/live/": { name: "index.html", type: "text/html; charset=utf-8" },
      "/index.html": { name: "index.html", type: "text/html; charset=utf-8" },
      "/app.js": { name: "app.js", type: "text/javascript; charset=utf-8" },
      "/styles.css": { name: "styles.css", type: "text/css; charset=utf-8" },
    };
    const file = staticFiles[url.pathname];
    if ((request.method === "GET" || request.method === "HEAD") && file) {
      const body = await readFile(path.join(webRoot, file.name));
      response.writeHead(200, {
        "Content-Type": file.type,
        "Content-Length": body.byteLength,
        "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    throw new HttpError(404, "not found");
  }

  async #serializeConfigurationUpdate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#configurationUpdates.then(operation, operation);
    this.#configurationUpdates = result.then(() => undefined, () => undefined);
    return await result;
  }

  async #syncOperatorConfiguration(checkpoint: RunCheckpoint): Promise<void> {
    const configured = operatorConfigurationFromCheckpoint(checkpoint);
    const key = JSON.stringify({ ...configured, updatedAt: null });
    if (key === this.#lastOperatorConfigurationKey) return;
    await writeOperatorConfiguration(this.rootDirectory, configured);
    this.#lastOperatorConfigurationKey = key;
  }

  async #broadcastPendingConfigurationAcks(runDirectory: string): Promise<void> {
    for (const [requestId, pendingRunDirectory] of this.#pendingConfigurationIds) {
      if (pendingRunDirectory !== runDirectory) continue;
      const acknowledgement = await readRuntimeConfigAck(runDirectory, requestId);
      if (!acknowledgement) continue;
      this.#pendingConfigurationIds.delete(requestId);
      this.#broadcast("configuration", acknowledgement);
    }
  }

  #startLivePreview(
    response: ServerResponse,
    device: string,
  ): void {
    const process = spawn(
      "ffmpeg",
      virtualCameraBrowserStreamArguments(device),
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    this.#livePreviews.set(response, process);
    response.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=ffmpeg",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      Connection: "close",
      "X-Content-Type-Options": "nosniff",
    });
    response.flushHeaders();
    process.stdout?.pipe(response);

    let stderr = "";
    process.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_192) stderr += chunk.toString("utf8");
    });
    const finish = () => {
      if (this.#livePreviews.get(response) !== process) return;
      this.#livePreviews.delete(response);
      process.stdout?.unpipe(response);
      if (!response.writableEnded) response.end();
    };
    response.once("close", () => {
      stopLivePreview(process);
      finish();
    });
    process.once("error", (error) => {
      this.#broadcast("supervisor", {
        type: "supervisor.warning",
        message: `Live preview failed: ${error.message}`,
      });
      finish();
    });
    process.once("exit", (code) => {
      if (code !== 0 && stderr.trim()) {
        this.#broadcast("supervisor", {
          type: "supervisor.warning",
          message: `Live preview stopped: ${stderr.trim().slice(-1_000)}`,
        });
      }
      finish();
    });
  }

  #startRunnerProxy(
    response: ServerResponse,
    port: number,
    pathname: string,
    fallbackContentType: string,
    label: string,
  ): void {
    const upstream = httpGet(
      `http://127.0.0.1:${port}${pathname}`,
      (source) => {
        if ((source.statusCode ?? 500) >= 400) {
          source.resume();
          this.#liveProxies.delete(response);
          if (!response.headersSent) {
            json(response, source.statusCode ?? 502, {
              error: `The ${label} is unavailable`,
            });
          }
          return;
        }
        response.writeHead(200, {
          "Content-Type": source.headers["content-type"] ??
            fallbackContentType,
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
          Connection: "close",
          "X-Content-Type-Options": "nosniff",
        });
        response.flushHeaders();
        source.pipe(response);
        source.once("end", () => this.#liveProxies.delete(response));
      },
    );
    this.#liveProxies.set(response, upstream);
    const finish = () => {
      const active = this.#liveProxies.get(response);
      if (active !== upstream) return;
      this.#liveProxies.delete(response);
      upstream.destroy();
    };
    response.once("close", finish);
    upstream.once("error", (error) => {
      finish();
      if (!response.headersSent) {
        json(response, 502, { error: `${label} failed: ${error.message}` });
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  }

  async #broadcastSnapshot(includeLibrary: boolean): Promise<BroadcastSnapshot> {
    const configuration = await readBroadcastConfiguration(this.rootDirectory);
    const library = await discoverBroadcastMedia(this.rootDirectory, configuration.manualFiles);
    const selected = selectedBroadcastMedia(configuration, library);
    const phase = this.#checkpoint && !isTerminal(this.#checkpoint.phase)
      ? this.#checkpoint.phase
      : null;
    const liveAvailable = phase === "running" && hasLiveRunner(this.#checkpoint);
    const playback = determineBroadcastPlayback({
      configuration,
      phase,
      liveAvailable,
      hasReplay: selected.length > 0,
    });
    const selectedPublic = await Promise.all(selected.map(async (item) => ({
      ...publicBroadcastMedia(item),
      ...await probeBroadcastMedia(item),
    })));
    return {
      configuration: publicBroadcastConfiguration(configuration, library),
      ...(includeLibrary ? { library: library.map(publicBroadcastMedia) } : {}),
      selected: selectedPublic,
      playback: {
        ...playback,
        phase,
        liveAvailable,
        retryAt: phase === "waiting_quota" ? this.#checkpoint?.retryAt ?? null : null,
      },
      liveUrl: `http://${this.host}:${this.#serverPort()}/live`,
      resolution: { width: 1920, height: 1080 },
    };
  }

  #serverPort(): number {
    const address = this.#server?.address();
    return typeof address === "object" && address ? address.port : this.port;
  }

  #requiredMusic(): MusicService {
    if (!this.#music) throw new HttpError(503, "Music service is not initialized");
    return this.#music;
  }

  async #selectedReplayItem(id: string | null): Promise<BroadcastMediaItem> {
    const configuration = await readBroadcastConfiguration(this.rootDirectory);
    const library = await discoverBroadcastMedia(this.rootDirectory, configuration.manualFiles);
    const item = selectedBroadcastMedia(configuration, library)
      .find((entry) => entry.id === id);
    if (!item) throw new HttpError(404, "Replay media is not in the active playlist");
    return item;
  }

  #startReplay(response: ServerResponse, item: BroadcastMediaItem): void {
    this.#startReplayStream(
      response,
      item,
      replayFfmpegArguments(item.filename),
      "video/mp4",
      "Replay",
    );
  }

  #startReplayStream(
    response: ServerResponse,
    item: BroadcastMediaItem,
    arguments_: string[],
    contentType: string,
    label: string,
  ): void {
    const process = spawn("ffmpeg", arguments_, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#replayStreams.set(response, process);
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      Connection: "close",
      "X-Content-Type-Options": "nosniff",
    });
    response.flushHeaders();
    process.stdout?.pipe(response);
    let stderr = "";
    process.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_192) stderr += chunk.toString("utf8");
    });
    const finish = () => {
      if (this.#replayStreams.get(response) !== process) return;
      this.#replayStreams.delete(response);
      process.stdout?.unpipe(response);
      if (!response.writableEnded) response.end();
    };
    response.once("close", () => {
      stopLivePreview(process);
      finish();
    });
    process.once("error", finish);
    process.once("exit", (code) => {
      if (code !== 0 && stderr.trim()) {
        this.#broadcast("supervisor", {
          type: "supervisor.warning",
          message: `${label} ${item.name} stopped: ${stderr.trim().slice(-1_000)}`,
        });
      }
      finish();
    });
  }

  #broadcastChanges(): void {
    const stateJson = JSON.stringify(this.#snapshot);
    if (stateJson !== this.#lastStateJson) {
      this.#lastStateJson = stateJson;
      this.#broadcast("state", this.#snapshot);
    }
    const transcriptKey = `${this.#checkpoint?.attempt ?? 0}:${this.#transcript.at(-1)?.sequence ?? 0}`;
    if (transcriptKey !== this.#lastTranscriptKey) {
      this.#lastTranscriptKey = transcriptKey;
      this.#broadcast("transcript_reset", this.#transcript);
    }
    if (this.#frame && this.#frame.etag !== this.#lastFrameEtag) {
      this.#lastFrameEtag = this.#frame.etag;
      this.#broadcast("frame", { sha256: this.#frame.etag.replaceAll('"', "") });
    }
  }

  #broadcast(name: string, value: unknown): void {
    const payload = `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
    for (const client of this.#clients) client.write(payload);
  }
}

function stopLivePreview(child: ChildProcess): void {
  if (child.exitCode !== null || !child.pid) return;
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // The preview process already exited.
  }
  const forced = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ }
  }, 1_000);
  forced.unref();
  child.once("exit", () => clearTimeout(forced));
}

async function loadOptions() {
  const [games, accounts, models, virtualCameras] = await Promise.all([
    discoverInstalledSteamGames(),
    discoverCodexAccounts(),
    discoverModels(),
    discoverVirtualCameraDevices(),
  ]);
  return {
    games: games.map(({ executable: _executable, manifest: _manifest, ...game }) => game),
    accounts: accounts.map((account) => ({
      id: account.id,
      displayName: path.basename(account.home) || "ChatGPT account",
    })),
    models,
    virtualCameras,
  };
}

async function discoverModels(): Promise<ModelOption[]> {
  const fallback: ModelOption[] = [{
    slug: "gpt-6-astra",
    displayName: "GPT-6-Astra",
    description: "Most capable model for complex computer use.",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultReasoningEffort: "low",
  }];
  const result = await runCommand("codex-proxy", ["debug", "models", "--bundled"], { timeoutMs: 20_000 });
  if (result.code !== 0) return fallback;
  try {
    const parsed = JSON.parse(result.stdout.toString("utf8")) as {
      models?: Array<{
        slug?: string;
        display_name?: string;
        description?: string;
        default_reasoning_level?: string;
        supported_reasoning_levels?: Array<{ effort?: string }>;
        visibility?: string;
      }>;
    };
    const models = (parsed.models ?? [])
      .filter((model) => model.slug && model.visibility !== "hidden")
      .map((model) => ({
        slug: model.slug!,
        displayName: model.display_name ?? model.slug!,
        description: model.description ?? "",
        reasoningEfforts: (model.supported_reasoning_levels ?? []).flatMap((level) => level.effort ? [level.effort] : []),
        defaultReasoningEffort: model.default_reasoning_level ?? "medium",
      }));
    return models.length > 0 ? models : fallback;
  } catch {
    return fallback;
  }
}

function checkpointSnapshot(checkpoint: RunCheckpoint) {
  const running = checkpoint.phase === "running" || checkpoint.phase === "starting";
  return {
    runId: checkpoint.runId,
    model: checkpoint.options.model ?? "gpt-6-astra",
    goal: checkpoint.options.goal ?? "Complete all official levels in Patrick's Parabox.",
    game: checkpoint.options.game
      ? { appId: checkpoint.options.game.appId, name: checkpoint.options.game.name }
      : { appId: "1260520", name: "Patrick's Parabox" },
    attempt: checkpoint.attempt,
    status: checkpoint.phase === "completed" ? "completed"
      : checkpoint.phase === "failed" ? "failed"
      : running ? "running" : "stopped",
    phase: checkpoint.phase,
    targetLevels: checkpoint.options.game?.appId === "1260520" || !checkpoint.options.game ? 364 : 0,
    progress: checkpoint.progress,
    time: {
      status: running ? "running" : checkpoint.phase === "completed" ? "completed" : "stopped",
      elapsedMs: checkpoint.elapsedMs,
      startedAt: checkpoint.startedAt,
      endedAt: running ? null : checkpoint.updatedAt,
      sampledAt: new Date().toISOString(),
    },
    tokens: { ...checkpoint.tokens, source: "exec", sampledAt: new Date().toISOString() },
    failure: checkpoint.phase === "failed" ? checkpoint.reason : null,
    completion: null,
    reason: checkpoint.reason,
    retryAt: checkpoint.retryAt,
  };
}

function emptySnapshot() {
  const now = new Date().toISOString();
  return {
    runId: null, model: "gpt-6-astra", goal: "", game: null, attempt: 0,
    status: "idle", phase: "idle", targetLevels: 0,
    progress: { total: 0, unlocked: 0, completed: 0 },
    time: { status: "idle", elapsedMs: 0, startedAt: null, endedAt: null, sampledAt: now },
    tokens: {
      inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
      reasoningOutputTokens: 0, totalTokens: 0, source: "none", sampledAt: now,
    },
    failure: null, completion: null, reason: null, retryAt: null,
  };
}

async function requiredCheckpoint(rootDirectory: string): Promise<RunCheckpoint> {
  const runDirectory = await readActiveRun(rootDirectory);
  if (!runDirectory) throw new HttpError(404, "No active challenge");
  return (await CheckpointStore.load(runDirectory)).snapshot();
}

async function stopAndCancel(checkpoint: RunCheckpoint): Promise<void> {
  if (checkpoint.pid !== null && processMatches(checkpoint.pid, checkpoint.pidStartTicks)) {
    process.kill(checkpoint.pid, "SIGINT");
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && processMatches(checkpoint.pid, checkpoint.pidStartTicks)) {
      await delay(250);
    }
    if (processMatches(checkpoint.pid, checkpoint.pidStartTicks)) {
      await stopRunWorker(checkpoint.runId).catch(() => undefined);
    }
  } else if (await runWorkerIsActive(checkpoint.runId)) {
    await stopRunWorker(checkpoint.runId).catch(() => undefined);
  }
  await cancelChallenge(checkpoint.runDirectory).catch(() => undefined);
  await cleanupPrivateGameAudio(checkpoint.runId).catch(() => undefined);
}

async function accountPoolSnapshot(checkpoint: RunCheckpoint | null): Promise<AccountPoolState | null> {
  if (!checkpoint) return null;
  try {
    const value = JSON.parse(
      await readFile(path.join(checkpoint.runDirectory, "account-pool.json"), "utf8"),
    ) as AccountPoolState;
    return value.version === 1 ? value : null;
  } catch {
    return null;
  }
}

function statusSnapshot(options: {
  rootDirectory: string;
  host: string;
  port: number;
  checkpoint: RunCheckpoint | null;
  challenge: unknown;
  accountPool: AccountPoolState | null;
  virtualCameras: Awaited<ReturnType<typeof discoverVirtualCameraDevices>>;
  operatorConfiguration: OperatorConfiguration | null;
  mediaState: RuntimeMediaState | null;
}) {
  const checkpoint = options.checkpoint;
  const names = accountDisplayNames(checkpoint);
  const accounts = options.accountPool?.accounts.map((account) =>
    publicAccountStatus(account, names.get(account.id))
  ) ?? [];
  const credentialPool = options.accountPool ? {
    activeAccountId: options.accountPool.activeAccountId,
    accounts: accounts.map((account) => ({
      id: account.id,
      displayName: account.displayName,
    })),
  } : null;
  const currentCredential = checkpoint
    ? currentCredentialStatus(checkpoint.credential, credentialPool)
    : null;
  const apiKeyActive = currentCredential?.mode === "api-key";
  const activeAccountId = apiKeyActive
    ? null
    : options.accountPool?.activeAccountId ?? null;
  const currentAccount = apiKeyActive
    ? null
    : accounts.find((account) => account.id === activeAccountId) ?? null;
  const futureResets = accounts.flatMap((account) => [
    account.fiveHour.resetsAt,
    account.weekly.resetsAt,
    account.blockedUntil,
  ]).filter((value): value is string =>
    value !== null && Date.parse(value) > Date.now()
  );
  const fiveHourResets = accounts
    .map((account) => account.fiveHour.resetsAt)
    .filter((value): value is string =>
      value !== null && Date.parse(value) > Date.now()
    );
  const earliestResetAt = apiKeyActive ? null : earliestIso(futureResets);
  const earliestFiveHourResetAt = apiKeyActive ? null : earliestIso(fiveHourResets);
  return {
    generatedAt: new Date().toISOString(),
    service: {
      ok: true,
      name: "astra-game-arena",
      url: `http://${options.host}:${options.port}`,
    },
    challenge: {
      active: checkpoint !== null && !isTerminal(checkpoint.phase),
      runId: checkpoint?.runId ?? null,
      phase: checkpoint?.phase ?? "idle",
      attempt: checkpoint?.attempt ?? 0,
      retryAt: checkpoint?.retryAt ?? null,
      reason: checkpoint?.reason ?? null,
      snapshot: options.challenge,
    },
    continuity: {
      mode: "retained-live-process",
      runtimeRetained:
        hasLiveRunner(checkpoint) && checkpoint.gameRuntimeReady === true,
      runtimeFrozen:
        hasLiveRunner(checkpoint) && checkpoint.gameRuntimeFrozen === true,
      coldRelaunchAllowed: false,
      daemonRestartSafe: true,
    },
    configuration: configurationStatus(
      checkpoint,
      options.rootDirectory,
      options.port,
      options.virtualCameras[0]?.device ?? "/dev/video10",
      options.operatorConfiguration,
    ),
    currentCredential,
    currentAccount,
    accountPool: {
      schedulingActive:
        checkpoint !== null && !isTerminal(checkpoint.phase) && !apiKeyActive,
      activeAccountId,
      accounts,
      earliestResetAt,
      earliestFiveHourResetAt,
    },
    earliestResetAt,
    recording: recordingStatus(checkpoint, options.mediaState),
    virtualCamera: {
      ...virtualCameraStatus(checkpoint, options.mediaState),
      available: options.virtualCameras.some((device) => device.writable),
      devices: options.virtualCameras,
    },
    virtualMicrophone: virtualMicrophoneStatus(checkpoint, options.mediaState),
  };
}

function configurationStatus(
  checkpoint: RunCheckpoint | null,
  rootDirectory: string,
  publicPort: number,
  defaultVirtualCameraDevice: string,
  operator: OperatorConfiguration | null = null,
) {
  const configured = checkpoint?.options;
  const launchMode = configured?.launchMode ??
    (configured?.offlineMode === true ? "direct" : operator?.launchMode ?? "steam-online");
  return {
    source: configured ? "active-run" : operator ? "saved" : "defaults",
    rootDirectory: configured?.rootDirectory ?? rootDirectory,
    publicPort: configured?.publicPort ?? publicPort,
    internalPort: configured?.port ?? 4318,
    game: configured?.game ?? null,
    gameAppId: configured?.game?.appId ?? operator?.gameAppId ?? "1260520",
    gpuPreference: configured?.gpuPreference ?? operator?.gpuPreference ?? "auto",
    launchMode,
    offlineMode: launchMode === "direct",
    goal:
      configured?.goal ?? operator?.goal ?? "Complete all official levels in Patrick's Parabox.",
    model: configured?.model ?? operator?.model ?? "gpt-6-astra",
    reasoningEffort: configured?.reasoningEffort ?? operator?.reasoningEffort ?? "high",
    record: configured?.record ?? operator?.record ?? true,
    virtualCamera: configured?.virtualCamera ?? operator?.virtualCamera ?? false,
    virtualCameraDevice:
      configured?.virtualCameraDevice ?? operator?.virtualCameraDevice ?? defaultVirtualCameraDevice,
    openDashboard: configured?.openDashboard ?? false,
    isolateSaves: configured?.isolateSaves ?? true,
    codexHome: configured?.codexHome ?? null,
    quotaWaitMs: configured?.quotaWaitMs ?? operator?.quotaWaitMs ?? 5 * 60 * 60_000,
    accountPolicies: configured?.accountPolicies ?? operator?.accountPolicies ?? [],
    webSearchEnabled: configured?.webSearchEnabled ?? operator?.webSearchEnabled ?? false,
    browserUseEnabled: configured?.browserUseEnabled ?? operator?.browserUseEnabled ?? false,
    toolCreationGuidance:
      configured?.toolCreationGuidance ?? operator?.toolCreationGuidance ?? false,
  };
}

function operatorConfigPath(rootDirectory: string): string {
  return path.join(rootDirectory, ".arena", OPERATOR_CONFIG_FILENAME);
}

async function readOperatorConfiguration(
  rootDirectory: string,
): Promise<OperatorConfiguration | null> {
  try {
    const value = JSON.parse(
      await readFile(operatorConfigPath(rootDirectory), "utf8"),
    ) as OperatorConfiguration;
    return value.version === 1 ? value : null;
  } catch {
    return null;
  }
}

async function writeOperatorConfiguration(
  rootDirectory: string,
  value: OperatorConfiguration,
): Promise<void> {
  await durableJsonWrite(operatorConfigPath(rootDirectory), value);
}

function configurationDefaults(
  configured: RunCheckpoint["options"] | undefined,
  operator: OperatorConfiguration | null,
  virtualCameraDevice: string,
): Omit<OperatorConfiguration, "version" | "updatedAt"> & { offlineMode: boolean } {
  const launchMode = configured?.launchMode ??
    (configured?.offlineMode === true ? "direct" : operator?.launchMode ?? "steam-online");
  return {
    gameAppId: configured?.game?.appId ?? operator?.gameAppId ?? "1260520",
    goal: configured?.goal ?? operator?.goal ??
      "Complete all official levels in Patrick's Parabox.",
    gpuPreference: configured?.gpuPreference ?? operator?.gpuPreference ?? "auto",
    launchMode,
    offlineMode: launchMode === "direct",
    model: configured?.model ?? operator?.model ?? "gpt-6-astra",
    reasoningEffort: configured?.reasoningEffort ?? operator?.reasoningEffort ?? "high",
    record: configured?.record ?? operator?.record ?? true,
    virtualCamera: configured?.virtualCamera ?? operator?.virtualCamera ?? false,
    virtualCameraDevice: configured?.virtualCameraDevice ??
      operator?.virtualCameraDevice ?? virtualCameraDevice,
    quotaWaitMs: configured?.quotaWaitMs ?? operator?.quotaWaitMs ?? 5 * 60 * 60_000,
    accountPolicies: configured?.accountPolicies ?? operator?.accountPolicies ?? [],
    webSearchEnabled: configured?.webSearchEnabled ?? operator?.webSearchEnabled ?? false,
    browserUseEnabled: configured?.browserUseEnabled ?? operator?.browserUseEnabled ?? false,
    toolCreationGuidance:
      configured?.toolCreationGuidance ?? operator?.toolCreationGuidance ?? false,
  };
}

function operatorConfigurationFromCheckpoint(
  checkpoint: RunCheckpoint,
): OperatorConfiguration {
  const configured = checkpoint.options;
  const launchMode = configured.launchMode ??
    (configured.offlineMode === true ? "direct" : "steam-online");
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    gameAppId: configured.game?.appId ?? "1260520",
    goal: configured.goal ?? "Complete all official levels in Patrick's Parabox.",
    gpuPreference: configured.gpuPreference,
    launchMode,
    model: configured.model ?? "gpt-6-astra",
    reasoningEffort: configured.reasoningEffort,
    record: configured.record,
    virtualCamera: configured.virtualCamera,
    virtualCameraDevice: configured.virtualCameraDevice,
    quotaWaitMs: configured.quotaWaitMs,
    accountPolicies: configured.accountPolicies ?? [],
    webSearchEnabled: configured.webSearchEnabled ?? false,
    browserUseEnabled: configured.browserUseEnabled ?? false,
    toolCreationGuidance: configured.toolCreationGuidance ?? false,
  };
}

function publicAccountStatus(account: AccountUsageState, configuredName?: string) {
  const nowMs = Date.now();
  const displayName = configuredName || account.displayName ||
    path.basename(account.home) || "ChatGPT account";
  return {
    id: account.id,
    displayName,
    label: displayName,
    reserveFiveHourPercent: account.reserveFiveHourPercent,
    reserveWeeklyPercent: account.reserveWeeklyPercent,
    fiveHour: publicRateWindow(account.primary, nowMs),
    weekly: publicRateWindow(account.secondary, nowMs),
    blockedUntil:
      account.blockedUntilMs !== null && account.blockedUntilMs > nowMs
        ? isoOrNull(account.blockedUntilMs)
        : null,
    updatedAt: account.updatedAt,
  };
}

function accountDisplayNames(checkpoint: RunCheckpoint | null): Map<string, string> {
  return new Map((checkpoint?.options.accountPolicies ?? []).flatMap((policy) => {
    const name = policy.displayName?.trim();
    return name ? [[policy.accountId, name] as const] : [];
  }));
}

function supervisorAccountPool(
  checkpoint: RunCheckpoint | null,
  accountPool: AccountPoolState | null,
) {
  if (!accountPool) return null;
  const names = accountDisplayNames(checkpoint);
  return {
    ...accountPool,
    accounts: accountPool.accounts.map((account) => {
      const { email: _email, home: _home, ...status } = account;
      return {
        ...status,
        displayName: names.get(account.id) || account.displayName ||
          path.basename(account.home) || "ChatGPT account",
      };
    }),
  };
}

function publicRateWindow(window: RateWindowState, nowMs: number) {
  const resetPassed =
    window.resetsAtMs !== null && window.resetsAtMs <= nowMs;
  const usedPercent = resetPassed ? 0 : window.usedPercent;
  return {
    usedPercent,
    remainingPercent:
      usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    resetsAt: resetPassed ? null : isoOrNull(window.resetsAtMs),
  };
}

function isoOrNull(value: number | null): string | null {
  return value === null || !Number.isFinite(value)
    ? null
    : new Date(value).toISOString();
}

function earliestIso(values: string[]): string | null {
  if (values.length === 0) return null;
  return values.reduce((earliest, value) =>
    Date.parse(value) < Date.parse(earliest) ? value : earliest
  );
}

function recordingStatus(
  checkpoint: RunCheckpoint | null,
  mediaState: RuntimeMediaState | null,
) {
  if (!checkpoint) {
    return { enabled: false, active: false, parts: 0, lastError: null };
  }
  return {
    enabled: checkpoint.options.record,
    active: hasLiveRunner(checkpoint) && mediaState?.recordingActive === true,
    parts: checkpoint.recordings.length,
    production: path.join(checkpoint.runDirectory, "production", "challenge-production-so-far.mkv"),
    lastError: mediaState?.recordingError ?? mediaState?.lastError ?? null,
  };
}

function virtualCameraStatus(
  checkpoint: RunCheckpoint | null,
  mediaState: RuntimeMediaState | null,
) {
  if (!checkpoint) {
    return { enabled: false, active: false, device: null, lastError: null };
  }
  const active = hasLiveRunner(checkpoint) && mediaState?.virtualCameraActive === true;
  return {
    enabled: checkpoint.options.virtualCamera,
    active,
    device: active
      ? mediaState?.virtualCameraDevice ?? null
      : checkpoint.options.virtualCameraDevice,
    lastError: mediaState?.virtualCameraError ?? mediaState?.lastError ?? null,
  };
}

function virtualMicrophoneStatus(
  checkpoint: RunCheckpoint | null,
  mediaState: RuntimeMediaState | null,
) {
  if (!checkpoint) {
    return {
      enabled: false,
      active: false,
      name: null,
      label: "Astra Game Microphone",
      lastError: null,
    };
  }
  return {
    enabled: checkpoint.options.virtualCamera,
    active: hasLiveRunner(checkpoint) && mediaState?.virtualMicrophoneActive === true,
    name: mediaState?.virtualMicrophoneName ?? null,
    label: "Astra Game Microphone",
    lastError: mediaState?.virtualMicrophoneError ?? mediaState?.lastError ?? null,
  };
}

function hasLiveRunner(checkpoint: RunCheckpoint | null): checkpoint is RunCheckpoint & { pid: number } {
  return checkpoint?.pid !== null &&
    checkpoint?.pid !== undefined &&
    processMatches(checkpoint.pid, checkpoint.pidStartTicks);
}

async function lastRuntimeFrame(checkpoint: RunCheckpoint) {
  for (let attempt = checkpoint.attempt; attempt >= 1; attempt--) {
    for (const directory of ["frame-checkpoints", "runtime-snapshots"]) {
      const filename = path.join(
        checkpoint.runDirectory,
        directory,
        `attempt-${String(attempt).padStart(4, "0")}.jpg`,
      );
      try {
        const data = await readFile(filename);
        return { data, type: "image/jpeg", etag: `"runtime-${attempt}-${data.length}"` };
      } catch {
        // Try the legacy directory, then the preceding attempt.
      }
    }
  }
  return null;
}

async function persistedTranscript(checkpoint: RunCheckpoint): Promise<TranscriptRecord[]> {
  const filename = path.join(checkpoint.runDirectory, "transcript.jsonl");
  try {
    const handle = await open(filename, "r");
    try {
      const info = await handle.stat();
      const maximumBytes = 16 * 1024 * 1024;
      const offset = Math.max(0, info.size - maximumBytes);
      const buffer = Buffer.allocUnsafe(info.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (offset > 0) lines.shift();
      return lines
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const record = JSON.parse(line) as TranscriptRecord;
            return typeof record.sequence === "number" ? [record] : [];
          } catch {
            return [];
          }
        })
        .slice(-1_000)
        .map((record, index) => ({ ...record, sequence: index + 1 }));
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(400) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function fetchBuffer(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(800) });
    if (!response.ok || response.status === 204) return null;
    const data = Buffer.from(await response.arrayBuffer());
    return {
      data,
      type: response.headers.get("content-type") ?? "image/jpeg",
      etag: response.headers.get("etag") ?? `"${data.length}"`,
    };
  } catch {
    return null;
  }
}

function parseMutableConfiguration(
  body: Record<string, unknown>,
  checkpoint: RunCheckpoint,
  options: Awaited<ReturnType<typeof loadOptions>>,
): Partial<MutableRuntimeConfiguration> {
  const immutable = ["game", "gameAppId", "gpuPreference", "launchMode", "offlineMode"];
  for (const field of immutable) {
    if (field in body) {
      throw new HttpError(409, `${field} cannot be changed during a challenge`);
    }
  }
  const allowed = new Set([
    "model",
    "reasoningEffort",
    "record",
    "virtualCamera",
    "virtualCameraDevice",
    "quotaWaitMs",
    "accountPolicies",
    "goal",
    "webSearchEnabled",
    "browserUseEnabled",
    "toolCreationGuidance",
  ]);
  const unknown = Object.keys(body).filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    throw new HttpError(400, `Unknown configuration field: ${unknown.join(", ")}`);
  }
  if (Object.keys(body).length === 0) {
    throw new HttpError(400, "At least one mutable configuration field is required");
  }

  const patch: Partial<MutableRuntimeConfiguration> = {};
  if ("goal" in body) {
    const goal = String(body.goal ?? "").trim();
    if (goal.length < 3 || goal.length > 4_000) {
      throw new HttpError(400, "Goal must contain 3 to 4000 characters");
    }
    patch.goal = goal;
  }
  if ("model" in body) {
    const model = String(body.model ?? "");
    if (!options.models.some((entry) => entry.slug === model)) {
      throw new HttpError(400, "Selected model is unavailable");
    }
    patch.model = model;
  }
  if ("reasoningEffort" in body) patch.reasoningEffort = parseReasoning(body.reasoningEffort);
  if ("record" in body) patch.record = strictBoolean(body.record, "record");
  if ("virtualCamera" in body) {
    patch.virtualCamera = strictBoolean(body.virtualCamera, "virtualCamera");
  }
  if ("virtualCameraDevice" in body) {
    patch.virtualCameraDevice = String(body.virtualCameraDevice ?? "");
  }
  const resultingVirtualCamera = patch.virtualCamera ?? checkpoint.options.virtualCamera;
  const resultingDevice = patch.virtualCameraDevice ?? checkpoint.options.virtualCameraDevice;
  if (
    resultingVirtualCamera &&
    !options.virtualCameras.some((entry) => entry.device === resultingDevice && entry.writable)
  ) {
    throw new HttpError(400, `Virtual camera ${resultingDevice} is unavailable or not writable`);
  }
  if ("quotaWaitMs" in body) {
    const quotaWaitMs = Number(body.quotaWaitMs);
    if (!Number.isSafeInteger(quotaWaitMs) || quotaWaitMs < 60_000 || quotaWaitMs > 7 * 24 * 60 * 60_000) {
      throw new HttpError(400, "quotaWaitMs must be an integer between 60000 and 604800000");
    }
    patch.quotaWaitMs = quotaWaitMs;
  }
  if ("accountPolicies" in body) {
    patch.accountPolicies = parseAccountPolicies(body.accountPolicies, options.accounts);
  }
  if ("webSearchEnabled" in body) {
    patch.webSearchEnabled = strictBoolean(body.webSearchEnabled, "webSearchEnabled");
  }
  if ("browserUseEnabled" in body) {
    patch.browserUseEnabled = strictBoolean(body.browserUseEnabled, "browserUseEnabled");
  }
  if ("toolCreationGuidance" in body) {
    patch.toolCreationGuidance = strictBoolean(
      body.toolCreationGuidance,
      "toolCreationGuidance",
    );
  }
  return patch;
}

function strictBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new HttpError(400, `${field} must be boolean`);
  return value;
}

function publicBroadcastMedia(item: BroadcastMediaItem): PublicBroadcastMediaItem {
  return {
    id: item.id,
    name: item.name,
    displayPath: item.displayPath,
    source: item.source,
    bytes: item.bytes,
    modifiedAt: item.modifiedAt,
  };
}

function publicBroadcastConfiguration(
  configuration: BroadcastConfiguration,
  library: readonly BroadcastMediaItem[],
): BroadcastSnapshot["configuration"] {
  const idByFilename = new Map(library.map((item) => [item.filename, item.id]));
  const { manualFiles, playlist, ...publicFields } = configuration;
  return {
    ...publicFields,
    playlist: playlist.flatMap((filename) => {
      const id = idByFilename.get(filename);
      return id ? [id] : [];
    }),
    manualFileCount: manualFiles.length,
  };
}

function broadcastConfigurationPatch(
  current: BroadcastConfiguration,
  body: Record<string, unknown>,
  library: readonly BroadcastMediaItem[],
): BroadcastConfiguration {
  const patch: Partial<BroadcastConfiguration> = {};
  if ("mode" in body) {
    const mode = String(body.mode);
    if (!(["auto", "live", "replay"] as string[]).includes(mode)) {
      throw new HttpError(400, "Broadcast mode must be auto, live, or replay");
    }
    patch.mode = mode as BroadcastConfiguration["mode"];
  }
  const booleanFields = [
    "loop",
    "replayWhenIdle",
    "replayWhenQuota",
    "replayWhenPaused",
    "replayWhenPower",
    "replayWhenRetry",
    "showReplayBadge",
    "showResetTime",
    "audioEnabled",
  ] as const;
  for (const field of booleanFields) {
    if (field in body) patch[field] = strictBoolean(body[field], field);
  }
  if ("replayBadgeText" in body) {
    const text = String(body.replayBadgeText ?? "").trim();
    if (!text || text.length > 80) {
      throw new HttpError(400, "Replay badge text must contain 1 to 80 characters");
    }
    patch.replayBadgeText = text;
  }
  if ("volume" in body) {
    const volume = Number(body.volume);
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      throw new HttpError(400, "Broadcast volume must be between 0 and 1");
    }
    patch.volume = volume;
  }
  if ("playlist" in body) {
    if (!Array.isArray(body.playlist) || body.playlist.length > 500) {
      throw new HttpError(400, "Broadcast playlist must be an array with at most 500 entries");
    }
    const byId = new Map(library.map((item) => [item.id, item.filename]));
    patch.playlist = [...new Set(body.playlist.map((entry) => {
      const filename = byId.get(String(entry));
      if (!filename) throw new HttpError(400, `Unknown replay media id: ${String(entry)}`);
      return filename;
    }))];
  }
  return { ...current, ...patch };
}

function parseLaunchMode(
  value: unknown,
  legacyOfflineMode: unknown = undefined,
): "steam-online" | "steam-offline" | "direct" {
  const mode = value === undefined
    ? legacyOfflineMode === true ? "direct" : "steam-online"
    : String(value);
  if (!(["steam-online", "steam-offline", "direct"] as string[]).includes(mode)) {
    throw new HttpError(400, "Invalid launch mode");
  }
  return mode as "steam-online" | "steam-offline" | "direct";
}

async function waitForRuntimeConfigAck(
  runDirectory: string,
  requestId: string,
  timeoutMs: number,
): Promise<RuntimeConfigAck | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ack = await readRuntimeConfigAck(runDirectory, requestId);
    if (ack) return ack;
    await delay(50);
  }
  return null;
}

function parseReasoning(value: unknown): "low" | "medium" | "high" | "xhigh" | "max" | "ultra" {
  const effort = String(value ?? "high");
  if (!(["low", "medium", "high", "xhigh", "max", "ultra"] as string[]).includes(effort)) {
    throw new HttpError(400, "Invalid reasoning effort");
  }
  return effort as "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
}

function parseGpuPreference(value: unknown): "auto" | "integrated" | "discrete" {
  const preference = String(value ?? "auto");
  if (!("auto integrated discrete".split(" ")).includes(preference)) {
    throw new HttpError(400, "Invalid GPU preference");
  }
  return preference as "auto" | "integrated" | "discrete";
}

function parseAccountPolicies(value: unknown, accounts: unknown[]): AccountPolicy[] {
  if (!Array.isArray(value)) return [];
  const known = new Map(accounts.flatMap((entry) => {
    const account = objectValue(entry);
    const id = account?.id;
    return typeof id === "string" ? [[id, account] as const] : [];
  }));
  const policies = value.map((raw) => {
    const entry = objectValue(raw);
    const accountId = String(entry?.accountId ?? "");
    if (!known.has(accountId)) throw new HttpError(400, "Unknown account in pool policy");
    const account = known.get(accountId);
    const fallbackName = String(account?.displayName ?? "ChatGPT account").trim();
    const requestedName = entry?.displayName;
    if (requestedName !== undefined && (
      typeof requestedName !== "string" ||
      requestedName.trim().length < 1 ||
      requestedName.trim().length > 80
    )) {
      throw new HttpError(400, "Account display names must contain 1 to 80 characters");
    }
    return {
      accountId,
      enabled: entry?.enabled !== false,
      displayName: typeof requestedName === "string"
        ? requestedName.trim()
        : fallbackName,
      reserveFiveHourPercent: percent(entry?.reserveFiveHourPercent),
      reserveWeeklyPercent: percent(entry?.reserveWeeklyPercent),
    };
  });
  if (policies.length > 0 && !policies.some((policy) => policy.enabled)) {
    throw new HttpError(400, "Enable at least one Codex account");
  }
  return policies;
}

function percent(value: unknown): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new HttpError(400, "Reserve percentages must be between 0 and 100");
  }
  return number;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 128_000) throw new HttpError(413, "Request body too large");
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "JSON object required");
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
