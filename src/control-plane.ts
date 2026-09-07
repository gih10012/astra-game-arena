import { open, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverCodexAccounts,
  type AccountPoolState,
  type AccountUsageState,
  type RateWindowState,
} from "./account-pool.js";
import { runCommand } from "./command.js";
import {
  CheckpointStore,
  clearActiveRun,
  isTerminal,
  processMatches,
  readActiveRun,
  registerActiveRun,
  type AccountPolicy,
  type RunCheckpoint,
} from "./run-checkpoint.js";
import { cancelChallenge, queueChallenge } from "./runner.js";
import { restoreFromRecovery } from "./save-guard.js";
import { discoverInstalledSteamGames } from "./steam-catalog.js";
import { discoverVirtualCameraDevices } from "./virtual-camera.js";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  import.meta.url.includes("/dist/") ? "../../web" : "../web",
);

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
  #lastStateJson = "";
  #lastTranscriptKey = "";
  #lastFrameEtag = "";
  #options: Awaited<ReturnType<typeof loadOptions>> | null = null;

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
    this.#refreshTimer = setInterval(() => void this.refresh(), 500);
    this.#refreshTimer.unref();
    return this.url;
  }

  async close(): Promise<void> {
    if (this.#refreshTimer) clearInterval(this.#refreshTimer);
    this.#refreshTimer = null;
    for (const client of this.#clients) client.end();
    this.#clients.clear();
    if (!this.#server) return;
    const server = this.#server;
    this.#server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
      json(response, 200, {
        ...this.#options,
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaults: {
          gameAppId: "1260520",
          goal: "Complete all official levels in Patrick's Parabox.",
          gpuPreference: "auto",
          offlineMode: false,
          model: "gpt-6-astra",
          reasoningEffort: "high",
          record: true,
          virtualCamera: false,
          virtualCameraDevice: this.#options.virtualCameras[0]?.device ?? "/dev/video10",
        },
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      const accountPool = await accountPoolSnapshot(this.#checkpoint);
      const virtualCameras = await discoverVirtualCameraDevices();
      json(response, 200, statusSnapshot({
        rootDirectory: this.rootDirectory,
        host: this.host,
        port: this.port,
        checkpoint: this.#checkpoint,
        challenge: this.#snapshot,
        accountPool,
        virtualCameras,
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/supervisor") {
      json(response, 200, {
        active: this.#checkpoint !== null,
        checkpoint: this.#checkpoint,
        accountPool: await accountPoolSnapshot(this.#checkpoint),
        recording: recordingStatus(this.#checkpoint),
        virtualCamera: virtualCameraStatus(this.#checkpoint),
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
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      response.write(`event: state\ndata: ${JSON.stringify(this.#snapshot)}\n\n`);
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
      const accountPolicies = parseAccountPolicies(body.accountPolicies, options.accounts);
      const virtualCamera = body.virtualCamera === true;
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
        if (!isTerminal(current.phase) && current.phase !== "paused") {
          throw new HttpError(409, `A challenge is already ${current.phase}`);
        }
        if (current.phase === "paused" && current.options.isolateSaves && current.savePrepared) {
          const recoveryPath = path.join(currentDirectory, "save-recovery.json");
          const recovery = JSON.parse(await readFile(recoveryPath, "utf8")) as {
            restoredAt?: string;
          };
          if (!recovery.restoredAt) await restoreFromRecovery(recoveryPath);
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
        offlineMode: body.offlineMode === true,
        reasoningEffort,
        record: body.record !== false,
        virtualCamera,
        virtualCameraDevice,
        openDashboard: false,
        accountPolicies,
      });
      await this.refresh();
      json(response, 202, outcome);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/control/pause") {
      const checkpoint = await requiredCheckpoint(this.rootDirectory);
      if (checkpoint.pid !== null && processMatches(checkpoint.pid, checkpoint.pidStartTicks)) {
        process.kill(checkpoint.pid, "SIGINT");
      } else {
        await (await CheckpointStore.load(checkpoint.runDirectory)).update({
          phase: "paused", pid: null, pidStartTicks: null, retryAt: null,
          reason: "Paused from control plane",
        });
      }
      json(response, 202, { accepted: true, action: "pause" });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/control/resume") {
      const checkpoint = await requiredCheckpoint(this.rootDirectory);
      if (checkpoint.phase !== "paused") throw new HttpError(409, "Challenge is not paused");
      await (await CheckpointStore.load(checkpoint.runDirectory)).update({
        phase: "waiting_retry", pid: null, pidStartTicks: null,
        retryAt: new Date().toISOString(), reason: "Resumed from control plane",
      });
      await registerActiveRun(this.rootDirectory, checkpoint.runDirectory);
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
      "/index.html": { name: "index.html", type: "text/html; charset=utf-8" },
      "/app.js": { name: "app.js", type: "text/javascript; charset=utf-8" },
      "/styles.css": { name: "styles.css", type: "text/css; charset=utf-8" },
    };
    const file = staticFiles[url.pathname];
    if (request.method === "GET" && file) {
      const body = await readFile(path.join(webRoot, file.name));
      response.writeHead(200, {
        "Content-Type": file.type,
        "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; connect-src 'self'; script-src 'self'; style-src 'self'",
        "Cache-Control": "no-cache",
      });
      response.end(body);
      return;
    }
    throw new HttpError(404, "not found");
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

async function loadOptions() {
  const [games, accounts, models, virtualCameras] = await Promise.all([
    discoverInstalledSteamGames(),
    discoverCodexAccounts(),
    discoverModels(),
    discoverVirtualCameraDevices(),
  ]);
  return {
    games: games.map(({ executable: _executable, manifest: _manifest, ...game }) => game),
    accounts: accounts.map((account) => ({ id: account.id, email: account.email, label: path.basename(account.home) })),
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
  }
  await cancelChallenge(checkpoint.runDirectory).catch(() => undefined);
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
}) {
  const checkpoint = options.checkpoint;
  const accounts = options.accountPool?.accounts.map(publicAccountStatus) ?? [];
  const currentAccount = accounts.find(
    (account) => account.id === options.accountPool?.activeAccountId,
  ) ?? null;
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
  const earliestResetAt = earliestIso(futureResets);
  const earliestFiveHourResetAt = earliestIso(fiveHourResets);
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
    configuration: configurationStatus(
      checkpoint,
      options.rootDirectory,
      options.port,
      options.virtualCameras[0]?.device ?? "/dev/video10",
    ),
    currentAccount,
    accountPool: {
      activeAccountId: options.accountPool?.activeAccountId ?? null,
      accounts,
      earliestResetAt,
      earliestFiveHourResetAt,
    },
    earliestResetAt,
    recording: recordingStatus(checkpoint),
    virtualCamera: {
      enabled: checkpoint?.options.virtualCamera ?? false,
      active:
        checkpoint?.options.virtualCamera === true && checkpoint.phase === "running",
      device: checkpoint?.options.virtualCameraDevice ?? null,
      available: options.virtualCameras.some((device) => device.writable),
      devices: options.virtualCameras,
    },
  };
}

function configurationStatus(
  checkpoint: RunCheckpoint | null,
  rootDirectory: string,
  publicPort: number,
  defaultVirtualCameraDevice: string,
) {
  const configured = checkpoint?.options;
  return {
    source: configured ? "active-run" : "defaults",
    rootDirectory: configured?.rootDirectory ?? rootDirectory,
    publicPort: configured?.publicPort ?? publicPort,
    internalPort: configured?.port ?? 4318,
    game: configured?.game ?? null,
    gameAppId: configured?.game?.appId ?? "1260520",
    gpuPreference: configured?.gpuPreference ?? "auto",
    offlineMode: configured?.offlineMode ?? false,
    goal:
      configured?.goal ?? "Complete all official levels in Patrick's Parabox.",
    model: configured?.model ?? "gpt-6-astra",
    reasoningEffort: configured?.reasoningEffort ?? "high",
    record: configured?.record ?? true,
    virtualCamera: configured?.virtualCamera ?? false,
    virtualCameraDevice:
      configured?.virtualCameraDevice ?? defaultVirtualCameraDevice,
    openDashboard: configured?.openDashboard ?? false,
    isolateSaves: configured?.isolateSaves ?? true,
    codexHome: configured?.codexHome ?? null,
    quotaWaitMs: configured?.quotaWaitMs ?? 5 * 60 * 60_000,
    accountPolicies: configured?.accountPolicies ?? [],
  };
}

function publicAccountStatus(account: AccountUsageState) {
  const nowMs = Date.now();
  return {
    id: account.id,
    email: account.email,
    label: path.basename(account.home),
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

function recordingStatus(checkpoint: RunCheckpoint | null) {
  if (!checkpoint) return { enabled: false, active: false, parts: 0 };
  return {
    enabled: checkpoint.options.record,
    active: checkpoint.options.record && checkpoint.phase === "running",
    parts: checkpoint.recordings.length,
    production: path.join(checkpoint.runDirectory, "production", "challenge-production-so-far.mkv"),
  };
}

function virtualCameraStatus(checkpoint: RunCheckpoint | null) {
  if (!checkpoint) return { enabled: false, active: false, device: null };
  return {
    enabled: checkpoint.options.virtualCamera,
    active:
      checkpoint.options.virtualCamera && checkpoint.phase === "running",
    device: checkpoint.options.virtualCameraDevice,
  };
}

async function lastRuntimeFrame(checkpoint: RunCheckpoint) {
  for (let attempt = checkpoint.attempt; attempt >= 1; attempt--) {
    const filename = path.join(
      checkpoint.runDirectory,
      "runtime-snapshots",
      `attempt-${String(attempt).padStart(4, "0")}.jpg`,
    );
    try {
      const data = await readFile(filename);
      return { data, type: "image/jpeg", etag: `"runtime-${attempt}-${data.length}"` };
    } catch {
      // Try the preceding attempt.
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
  const known = new Set(accounts.flatMap((entry) => {
    const id = objectValue(entry)?.id;
    return typeof id === "string" ? [id] : [];
  }));
  const policies = value.map((raw) => {
    const entry = objectValue(raw);
    const accountId = String(entry?.accountId ?? "");
    if (!known.has(accountId)) throw new HttpError(400, "Unknown account in pool policy");
    return {
      accountId,
      enabled: entry?.enabled !== false,
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
