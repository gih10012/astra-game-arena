import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { AuditLog, createRunId } from "./audit-log.js";
import {
  AccountPool,
  discoverCodexAccounts,
  inheritCodexConfiguration,
} from "./account-pool.js";
import { ChallengeState } from "./challenge-state.js";
import {
  apiKeyRuntimeHome,
  CHATGPT_POOL_CREDENTIAL,
  CODEX_COMMAND,
  codexEnvironment,
  credentialAfterModelChange,
  displayCodexHome,
  isHistoricalUnsupportedChatGptModel,
  isChatGptModelUnsupportedError,
  prepareApiKeyRuntimeHome,
  publicApiKeyCredential,
  resolveApiKeyCredential,
  resolveCodexHome,
} from "./codex-home.js";
import {
  emptyTokenUsage,
  extractQuotaResetAt,
  extractRateLimits,
  extractTokenUsage,
  publicTranscriptEvent,
} from "./codex-events.js";
import { runCommand } from "./command.js";
import { ArenaController } from "./controller.js";
import { defaultGamePaths } from "./doctor.js";
import { X11GameAdapter } from "./game-adapter.js";
import {
  startVirtualDashboard,
  startVirtualGame,
  type VirtualDashboardRuntime,
  type VirtualGameRuntime,
} from "./headless-display.js";
import {
  discoverCompletedRecordingPairs,
  recordingPairIsActive,
  startRecordingPair,
  stopAndComposeRecordingPair,
  type ActiveRecordingPair,
} from "./recording-pair.js";
import { RolloutTailer } from "./rollout-tailer.js";
import {
  assembleRecordings,
  type RecordingAssembly,
} from "./recording-assembly.js";
import {
  CheckpointStore,
  checkpointPath,
  clearActiveRun,
  processMatches,
  processStartTicks,
  registerActiveRun,
  type RunCheckpoint,
  type RunPhase,
  type AccountPolicy,
  type CodexCredentialState,
} from "./run-checkpoint.js";
import {
  readRuntimeMediaState,
  readRuntimeConfigRequest,
  writeRuntimeConfigAck,
  writeRuntimeMediaState,
  type RuntimeMediaState,
} from "./runtime-config.js";
import { SaveGuard } from "./save-guard.js";
import {
  powerAllowsResume,
  readPowerState,
  shouldSnapshotForLowBattery,
  type PowerState,
} from "./power.js";
import { parseParaboxSave } from "./save-parser.js";
import {
  TARGET_LEVELS,
  type GameFrame,
  type LevelProgress,
} from "./types.js";
import {
  findInstalledSteamGame,
  type InstalledSteamGame,
} from "./steam-catalog.js";
import {
  startVirtualCamera,
  type ActiveVirtualCamera,
} from "./virtual-camera.js";

export const DEFAULT_GOAL = "Complete all official levels in Patrick's Parabox.";
export const NEUTRAL_PROMPT = initialPrompt(DEFAULT_GOAL, "Patrick's Parabox", {});
export const RESUME_PROMPT = continuationPrompt(DEFAULT_GOAL, {});

const DEFAULT_QUOTA_WAIT_MS = 5 * 60 * 60 * 1_000;
const QUOTA_RESET_GRACE_MS = 60_000;

export interface RunOptions {
  rootDirectory: string;
  port?: number;
  publicPort?: number;
  model?: string;
  goal?: string;
  gameAppId?: string;
  gpuPreference?: "auto" | "integrated" | "discrete";
  launchMode?: "steam-online" | "steam-offline" | "direct";
  offlineMode?: boolean;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  record?: boolean;
  virtualCamera?: boolean;
  virtualCameraDevice?: string;
  openDashboard?: boolean;
  isolateSaves?: boolean;
  output?: string;
  codexHome?: string;
  quotaWaitMs?: number;
  accountPolicies?: AccountPolicy[];
  webSearchEnabled?: boolean;
  browserUseEnabled?: boolean;
  toolCreationGuidance?: boolean;
}

export interface RunOutcome {
  runDirectory: string;
  phase: RunPhase;
  retryAt: string | null;
  reason: string | null;
}

type RequestedAttemptStop = "pause" | "restart" | "game-exit";

export async function runChallenge(options: RunOptions): Promise<RunOutcome> {
  const checkpoint = await initializeChallenge(options, false);
  return await runAttempt(checkpoint);
}

export async function queueChallenge(options: RunOptions): Promise<RunOutcome> {
  const checkpoint = await initializeChallenge(options, true);
  const queued = checkpoint.snapshot();
  return {
    runDirectory: queued.runDirectory,
    phase: queued.phase,
    retryAt: queued.retryAt,
    reason: queued.reason,
  };
}

async function initializeChallenge(
  options: RunOptions,
  queued: boolean,
): Promise<CheckpointStore> {
  const runId = createRunId();
  const runDirectory = path.resolve(
    options.output ?? path.join(options.rootDirectory, "runs", runId),
  );
  const rootDirectory = path.resolve(options.rootDirectory);
  const codexHome = await resolveCodexHome(options.codexHome);
  const game = await findInstalledSteamGame(options.gameAppId ?? "1260520");
  const model = normalizeModel(options.model ?? "gpt-6-astra");
  const goal = normalizeGoal(options.goal ?? DEFAULT_GOAL);
  const launchMode = options.launchMode ??
    (options.offlineMode === true ? "direct" : "steam-online");
  const now = new Date().toISOString();
  const persistedOptions: RunCheckpoint["options"] = {
    rootDirectory,
    publicPort: options.publicPort ?? 4317,
    port: options.port ?? 4318,
    model,
    goal,
    game,
    gpuPreference: options.gpuPreference ?? "auto",
    launchMode,
    offlineMode: launchMode === "direct",
    reasoningEffort: options.reasoningEffort ?? "high",
    record: options.record !== false,
    virtualCamera: options.virtualCamera === true,
    virtualCameraDevice: options.virtualCameraDevice ?? "/dev/video10",
    openDashboard: options.openDashboard === true,
    isolateSaves: game.appId === "1260520" && options.isolateSaves !== false,
    quotaWaitMs: options.quotaWaitMs ?? DEFAULT_QUOTA_WAIT_MS,
    accountPolicies: options.accountPolicies ?? [],
    webSearchEnabled: options.webSearchEnabled === true,
    browserUseEnabled: options.browserUseEnabled === true,
    toolCreationGuidance: options.toolCreationGuidance === true,
    ...(codexHome ? { codexHome } : {}),
  };
  const initialCheckpoint: RunCheckpoint = {
    version: 1,
    runId,
    runDirectory,
    createdAt: now,
    updatedAt: now,
    phase: queued ? "waiting_retry" : "starting",
    attempt: 0,
    pid: queued ? null : process.pid,
    pidStartTicks: queued ? null : processStartTicks(),
    threadId: null,
    retryAt: queued ? now : null,
    reason: queued ? "Queued for the systemd watchdog" : null,
    savePrepared: false,
    elapsedMs: 0,
    startedAt: null,
    tokens: emptyTokenUsage(),
    tokenCursor: null,
    progress: { total: 0, unlocked: 0, completed: 0 },
    recordings: [],
    recordingPairs: [],
    credential: CHATGPT_POOL_CREDENTIAL,
    options: persistedOptions,
  };
  const audit = new AuditLog(runDirectory);
  const runConfig = {
    runId,
    createdAt: now,
    model,
    reasoningEffort: persistedOptions.reasoningEffort,
    goal,
    gpuPreference: persistedOptions.gpuPreference,
    launchMode: persistedOptions.launchMode,
    offlineMode: persistedOptions.offlineMode,
    prompt: initialPrompt(goal, game.name, persistedOptions),
    resumePrompt: continuationPrompt(goal, persistedOptions),
    targetLevels: game.appId === "1260520" ? TARGET_LEVELS : null,
    observationPolicy: "pixels-only",
    actionPolicy: "isolated-keyboard-and-mouse",
    webSearch: persistedOptions.webSearchEnabled ? "live" : "disabled",
    networkBrowser: persistedOptions.browserUseEnabled ? "enabled" : "disabled",
    toolCreationGuidance: persistedOptions.toolCreationGuidance,
    shellNetwork: "standard",
    standardCodexCapabilities: true,
    codexLauncher: CODEX_COMMAND,
    codexHome: displayCodexHome(codexHome),
    saveIsolation: persistedOptions.isolateSaves,
    recording: persistedOptions.record,
    virtualCamera: {
      enabled: persistedOptions.virtualCamera,
      device: persistedOptions.virtualCameraDevice,
    },
    displayBackend: "cage-headless-xwayland",
    recordingBackend: "cage-wlr-screencopy+native-cfr-composite",
    physicalDesktopWindows: persistedOptions.openDashboard ? "monitor-only" : "none",
    resumable: true,
    quotaWaitMs: persistedOptions.quotaWaitMs,
  };
  await audit.initialize(runConfig);
  const checkpoint = new CheckpointStore(
    checkpointPath(runDirectory),
    initialCheckpoint,
  );
  await checkpoint.update({});
  if (queued) {
    await audit.append("challenge.queued", {
      supervisor: "astra-game-arena-watchdog.service",
      controlPlane: `http://127.0.0.1:${persistedOptions.publicPort}`,
    });
  }
  await registerActiveRun(rootDirectory, runDirectory);
  return checkpoint;
}

export async function resumeChallenge(runDirectory: string): Promise<RunOutcome> {
  const checkpoint = await CheckpointStore.load(runDirectory);
  const current = checkpoint.snapshot();
  if (current.phase === "completed" || current.phase === "failed") {
    throw new Error(`Run is already ${current.phase}: ${current.runDirectory}`);
  }
  if (
    (current.phase === "running" || current.phase === "starting") &&
    current.pid !== null &&
    processMatches(current.pid, current.pidStartTicks)
  ) {
    throw new Error(`Run is already active with PID ${current.pid}`);
  }
  await registerActiveRun(current.options.rootDirectory, current.runDirectory);
  return await runAttempt(checkpoint);
}

export async function cancelChallenge(runDirectory: string): Promise<RunOutcome> {
  const checkpoint = await CheckpointStore.load(runDirectory);
  const current = checkpoint.snapshot();
  if (current.phase === "completed" || current.phase === "failed") {
    throw new Error(`Run is already ${current.phase}: ${current.runDirectory}`);
  }
  if (
    (current.phase === "running" || current.phase === "starting") &&
    current.pid !== null &&
    processMatches(current.pid, current.pidStartTicks)
  ) {
    throw new Error(`Stop active PID ${current.pid} before cancelling the run`);
  }
  let restored = false;
  if (current.options.isolateSaves && current.savePrepared) {
    const saveGuard = new SaveGuard(defaultGamePaths().saveDirectory, current.runDirectory);
    await saveGuard.load();
    await saveGuard.restore();
    restored = true;
  }
  const reason = "Cancelled by operator";
  await checkpoint.update({
    phase: "failed",
    pid: null,
    pidStartTicks: null,
    retryAt: null,
    reason,
  });
  const audit = new AuditLog(current.runDirectory);
  await audit.append("challenge.cancelled", { reason, savesRestored: restored });
  await audit.finalize({
    status: "failed",
    reason,
    checkpoint: checkpoint.snapshot(),
    savesRestored: restored,
  });
  await clearActiveRun(current.options.rootDirectory, current.runDirectory);
  return {
    runDirectory: current.runDirectory,
    phase: "failed",
    retryAt: null,
    reason,
  };
}

async function runAttempt(checkpointStore: CheckpointStore): Promise<RunOutcome> {
  const prior = checkpointStore.snapshot();
  let attempt = prior.attempt + 1;
  const initialPart = String(attempt).padStart(4, "0");
  const runDirectory = prior.runDirectory;
  const rootDirectory = prior.options.rootDirectory;
  const frameDirectory = path.join(runDirectory, "frames", `part-${initialPart}`);
  const runtimeDirectory = path.join(runDirectory, "runtime", `part-${initialPart}`);
  const workDirectory = path.join(runDirectory, "workspace");
  const mcpEntry = path.join(rootDirectory, "dist/src/mcp.js");
  await access(mcpEntry);
  await mkdir(frameDirectory, { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  await mkdir(workDirectory, { recursive: true });
  await mkdir(path.join(runDirectory, "recordings"), { recursive: true });

  const selectedGame = prior.options.game ?? await findInstalledSteamGame("1260520");
  const paths = defaultGamePaths();
  const isParabox = selectedGame.appId === "1260520";
  const audit = new AuditLog(runDirectory);
  const state = new ChallengeState(
    prior.options.model ?? "gpt-6-astra",
    isParabox ? TARGET_LEVELS : 0,
    attempt,
    prior.options.goal ?? DEFAULT_GOAL,
    { appId: selectedGame.appId, name: selectedGame.name },
  );
  const isColdResume = prior.attempt > 0;
  const saveGuard = new SaveGuard(paths.saveDirectory, runDirectory);
  const codexHome = prior.options.codexHome;
  const primaryCodexHome = codexHome ?? path.join(os.homedir(), ".codex");
  let apiKeyCredential = await resolveApiKeyCredential();
  let credential: CodexCredentialState =
    prior.credential?.mode === "api-key" && apiKeyCredential
      ? publicApiKeyCredential(apiKeyCredential)
      : { ...CHATGPT_POOL_CREDENTIAL };
  const configuredModel = prior.options.model ?? "gpt-6-astra";
  const restoredApiKeyFallback =
    credential.mode === "chatgpt-pool" &&
    apiKeyCredential !== null &&
    await hasHistoricalUnsupportedChatGptModel(runDirectory, configuredModel);
  if (restoredApiKeyFallback && apiKeyCredential) {
    credential = publicApiKeyCredential(apiKeyCredential);
  }
  const apiKeyHome = apiKeyRuntimeHome();
  let apiKeyHomePrepared = false;
  const prepareApiKeyHome = async (): Promise<string> => {
    apiKeyCredential ??= await resolveApiKeyCredential();
    if (!apiKeyCredential) {
      throw new Error("No configured API-key credential is available");
    }
    if (!apiKeyHomePrepared) {
      await prepareApiKeyRuntimeHome(apiKeyCredential, apiKeyHome, [
        rootDirectory,
        runDirectory,
      ]);
      apiKeyHomePrepared = true;
    }
    return apiKeyHome;
  };
  if (credential.mode === "api-key") await prepareApiKeyHome();
  let accountProfiles = await discoverCodexAccounts();
  await Promise.all(
    accountProfiles.map((profile) =>
      inheritCodexConfiguration(profile.home, codexHome),
    ),
  );
  let accountPool = accountProfiles.length > 0
    ? await AccountPool.open(runDirectory, accountProfiles, prior.options.accountPolicies)
    : null;
  await checkpointStore.update({
    phase: "starting",
    attempt,
    pid: process.pid,
    pidStartTicks: processStartTicks(),
    retryAt: null,
    reason: null,
    credential,
  });
  await audit.append("attempt.started", { attempt, resumed: attempt > 1 });
  if (restoredApiKeyFallback) {
    await audit.append("credential.fallback.restored", {
      attempt,
      mode: credential.mode,
      provider: credential.provider,
      label: credential.label,
      reason: "persisted-chatgpt-model-unsupported-diagnostic",
    });
  }

  let codex: ChildProcess | null = null;
  let recorder: ActiveRecordingPair | null = null;
  let virtualCamera: ActiveVirtualCamera | null = null;
  let browser: ChildProcess | null = null;
  let game: X11GameAdapter | null = null;
  let controller: ArenaController | null = null;
  let virtualGame: VirtualGameRuntime | null = null;
  let virtualDashboard: VirtualDashboardRuntime | null = null;
  let holdingOverlay: ChildProcess | null = null;
  let gameWindow: { windowId: number; title: string } | null = null;
  const tailers = new Set<RolloutTailer>();
  const tailerTasks = new Set<Promise<void>>();
  const eventTasks = new Set<Promise<void>>();
  let savePoll: NodeJS.Timeout | null = null;
  let checkpointPoll: NodeJS.Timeout | null = null;
  let gameHealthPoll: NodeJS.Timeout | null = null;
  let powerPoll: NodeJS.Timeout | null = null;
  let accountPoll: NodeJS.Timeout | null = null;
  let runtimeConfigPoll: NodeJS.Timeout | null = null;
  const checkpointWork: { current: Promise<void> | null } = { current: null };
  let checkpointBusy = false;
  let gameHealthBusy = false;
  let missingGameHealthChecks = 0;
  let restored = false;
  let quotaExhausted = false;
  let quotaResetAtMs: number | null = null;
  let activeAccountId: string | null = null;
  let reservePauseRequested = false;
  let accountRotationRequested = false;
  let configurationRestartRequested = false;
  let configurationRestartAwaitingThread = false;
  let hotCodexConfigurationRestartRequested = false;
  let recordingFailureRequested = false;
  let runtimeConfigBusy = false;
  let runtimeConfigGeneration = 0;
  let codexInvocation = 0;
  let quotaFallbackStartedAtMs: number | null = null;
  let unsupportedChatGptModel: string | null = null;
  let exitDescription = "Codex exited before completion";
  let requestedStop: RequestedAttemptStop | null = null;
  let powerPauseRequested = false;
  let lastPowerState: PowerState | null = null;
  let powerPauseReason = "Low battery; snapshot saved until wake or external power";
  let powerCheckBusy = false;
  let outcomePhase: RunPhase = "waiting_retry";
  let retryAt: string | null = null;
  let reason: string | null = null;
  let productionVideo: RecordingAssembly | null = null;
  let controllerUrl: string | null = null;
  const startupAbortController = new AbortController();
  const configurationCanReloadContinuously = () =>
    canReloadCodexContinuously({
      hotRestartRequested: hotCodexConfigurationRestartRequested,
      stopRequested: requestedStop !== null,
      powerPauseRequested,
      recordingFailureRequested,
      quotaExhausted,
      reservePauseRequested,
      accountRotationRequested,
    });
  let mediaOperations: Promise<void> = Promise.resolve();
  const restoredMediaState = await readRuntimeMediaState(runDirectory);
  let mediaState: RuntimeMediaState = restoredMediaState ? {
    ...restoredMediaState,
    recordingError: restoredMediaState.recordingError ?? restoredMediaState.lastError ?? null,
    virtualCameraError:
      restoredMediaState.virtualCameraError ?? restoredMediaState.lastError ?? null,
  } : {
    version: 1,
    updatedAt: new Date().toISOString(),
    recordingActive: false,
    recordingError: null,
    virtualCameraActive: false,
    virtualCameraDevice: null,
    virtualCameraError: null,
  };
  const recordedAttempts = new Set(
    (prior.recordingPairs ?? []).map((pair) => pair.attempt),
  );

  const adoptCompletedRecordingPairs = async () => {
    const current = checkpointStore.snapshot();
    const recovered = await discoverCompletedRecordingPairs(
      runDirectory,
      current.recordingPairs ?? [],
      current.recordings,
      attempt,
    );
    if (recovered.length === 0) return;
    await checkpointStore.update((latest) => ({
      recordings: [...new Set([...latest.recordings, ...recovered])],
    }));
    await audit.append("recording.recovered", { recordings: recovered });
  };

  const updateMediaState = async (patch: Partial<RuntimeMediaState>) => {
    mediaState = {
      ...mediaState,
      ...patch,
      version: 1,
      updatedAt: new Date().toISOString(),
    };
    await writeRuntimeMediaState(runDirectory, mediaState);
  };
  const withMediaOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mediaOperations.catch(() => undefined).then(operation);
    mediaOperations = result.then(() => undefined, () => undefined);
    return await result;
  };
  await updateMediaState({
    recordingActive: false,
    recordingError: null,
    virtualCameraActive: false,
    virtualCameraDevice: null,
    virtualCameraError: null,
  });

  const stopCodex = () => {
    const activeCodex = codex;
    if (activeCodex?.exitCode !== null || !activeCodex.pid) return;
    signalProcessGroup(activeCodex, "SIGINT");
    const terminate = setTimeout(() => {
      if (activeCodex.exitCode === null) signalProcessGroup(activeCodex, "SIGTERM");
    }, 2_000);
    const kill = setTimeout(() => {
      if (activeCodex.exitCode === null) signalProcessGroup(activeCodex, "SIGKILL");
    }, 5_000);
    terminate.unref();
    kill.unref();
  };

  const stopRecordingUnlocked = async () => {
    const activeRecorder = recorder;
    recorder = null;
    if (!activeRecorder) return;
    await updateMediaState({ recordingActive: false });
    try {
      const compositeRelative = await stopAndComposeRecordingPair(
        runDirectory,
        activeRecorder,
      );
      await checkpointStore.update((current) => ({
        recordings: current.recordings.includes(compositeRelative)
          ? current.recordings
          : [...current.recordings, compositeRelative],
      }));
      await audit.append("recording.sealed", {
        attempt: activeRecorder.metadata.attempt,
        filename: compositeRelative,
        gameSource: activeRecorder.metadata.game,
        dashboardSource: activeRecorder.metadata.dashboard,
        snapshot: state.snapshot(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateMediaState({ recordingActive: false, recordingError: message });
      await audit.append("recording.seal.warning", {
        attempt: activeRecorder.metadata.attempt,
        message,
      });
      controller?.publishTranscript({ type: "runner.error", message: `Recording part could not be sealed: ${message}` });
      throw error;
    }
  };

  const stopForRecordingFailure = (
    failedAttempt: number,
    message: string,
    failedRecorder: ActiveRecordingPair | null,
  ) => {
    if (failedRecorder) failedRecorder.stopping = true;
    if (requestedStop === null) {
      recordingFailureRequested = true;
      exitDescription = `Recording coverage failed: ${message}`;
    }
    interruptActiveTiming(state, () => {
      controller?.cancelPendingActions();
      stopCodex();
    });
    void withMediaOperation(async () => {
      if (failedRecorder && recorder !== failedRecorder) return;
      await stopRecordingUnlocked().catch(() => undefined);
      await updateMediaState({ recordingActive: false, recordingError: message });
      await audit.append("recording.failed", { attempt: failedAttempt, message });
      controller?.publishTranscript({ type: "runner.error", message });
    });
  };

  const startRecordingUnlocked = async (
    currentAttempt: number,
    configured: RunCheckpoint["options"],
    allowStopped: boolean,
  ): Promise<boolean> => {
    if (recorder || !configured.record || !virtualGame || !virtualDashboard) {
      return false;
    }
    if (!allowStopped && state.snapshot().status !== "running") return false;
    if (recordedAttempts.has(currentAttempt)) return true;
    const currentPart = String(currentAttempt).padStart(4, "0");
    const recordingRelative = path.join(
      "recordings",
      `challenge-part-${currentPart}.mkv`,
    );
    let started: ActiveRecordingPair | null = null;
    try {
      started = await startRecordingPair({
        runDirectory,
        attempt: currentAttempt,
        game: virtualGame,
        dashboard: virtualDashboard,
        audit,
        onUnexpectedExit: (message) => {
          if (!started || recorder !== started || started.stopping) return;
          const recordingRequired = checkpointStore.snapshot().options.record;
          if (recordingRequired) {
            stopForRecordingFailure(currentAttempt, message, started);
            return;
          }
          started.stopping = true;
          void withMediaOperation(async () => {
            if (recorder !== started) return;
            await stopRecordingUnlocked().catch(() => undefined);
            await updateMediaState({ recordingActive: false, recordingError: message });
          });
        },
      });
      recorder = started;
      recordedAttempts.add(currentAttempt);
      await updateMediaState({ recordingActive: true, recordingError: null });
    } catch (error) {
      await updateMediaState({
        recordingActive: false,
        recordingError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    await checkpointStore.update((current) => ({
      recordingPairs: [
        ...(current.recordingPairs ?? []).filter((pair) => pair.attempt !== currentAttempt),
        started!.metadata,
      ],
    }));
    await audit.append("recording.started", {
      attempt: currentAttempt,
      backend: "cage-wlr-screencopy+dashboard-x11grab",
      dimensions: "1920x1080",
      framesPerSecond: 30,
      timestampMode: "frame-count",
      captureStartedAt: started.captureStartedAt,
      snapshot: state.snapshot(),
      filename: recordingRelative,
    });
    return false;
  };

  const stopVirtualCameraUnlocked = async () => {
    const active = virtualCamera;
    virtualCamera = null;
    if (!active) return;
    await updateMediaState({
      virtualCameraActive: false,
      virtualCameraDevice: null,
    });
    try {
      await active.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateMediaState({ virtualCameraError: message });
      await audit.append("virtual_camera.stop.warning", message);
      throw error;
    }
    await audit.append("virtual_camera.stopped", { device: active.device });
  };

  const startCameraOutputUnlocked = async (
    configured: RunCheckpoint["options"],
    allowStopped: boolean,
  ) => {
    if (virtualCamera || !configured.virtualCamera || !virtualGame || !virtualDashboard) return;
    if (!allowStopped && state.snapshot().status !== "running") return;
    let started: ActiveVirtualCamera | null = null;
    try {
      started = await startVirtualCamera({
        device: configured.virtualCameraDevice,
        game: virtualGame,
        dashboard: virtualDashboard,
        audit,
        onUnexpectedExit: (message) => {
          void withMediaOperation(async () => {
            if (virtualCamera !== started) return;
            await stopVirtualCameraUnlocked().catch(() => undefined);
            await updateMediaState({
              virtualCameraActive: false,
              virtualCameraDevice: null,
              virtualCameraError: message,
            });
            await audit.append("virtual_camera.failed", { message });
            controller?.publishTranscript({ type: "runner.error", message });
          });
        },
      });
      virtualCamera = started;
      await updateMediaState({
        virtualCameraActive: true,
        virtualCameraDevice: started.device,
        virtualCameraError: null,
      });
    } catch (error) {
      await updateMediaState({
        virtualCameraActive: false,
        virtualCameraDevice: null,
        virtualCameraError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    await audit.append("virtual_camera.started", {
      device: started.device,
      dimensions: "1920x1080",
      framesPerSecond: 30,
      layout: "native-game-1920x1080-fit-into-1280x1080+codex-session-640x1080",
    });
    controller?.publishTranscript({
      type: "runner.virtual_camera_started",
      device: started.device,
    });
  };

  const ensureVirtualDashboardUnlocked = async () => {
    if (virtualDashboard || !virtualGame || !controllerUrl) return;
    virtualDashboard = await startVirtualDashboard({
      rootDirectory,
      runtimeDirectory,
      url: controllerUrl,
    });
  };
  const ensureVirtualDashboard = async () =>
    await withMediaOperation(ensureVirtualDashboardUnlocked);
  const stopRecording = async () =>
    await withMediaOperation(stopRecordingUnlocked);
  const startRecording = async (currentAttempt: number, allowStopped = false) =>
    await withMediaOperation(async () =>
      await startRecordingUnlocked(
        currentAttempt,
        checkpointStore.snapshot().options,
        allowStopped,
      )
    );
  const stopVirtualCamera = async () =>
    await withMediaOperation(stopVirtualCameraUnlocked);
  const startCameraOutput = async (allowStopped = false) =>
    await withMediaOperation(async () =>
      await startCameraOutputUnlocked(
        checkpointStore.snapshot().options,
        allowStopped,
      )
    );
  const activateAttemptTiming = (
    mode: "start" | "resume",
    currentAttempt: number,
  ): { activeStartedAt: string; activeStartedElapsedMs: number } | null => {
    const configured = checkpointStore.snapshot().options;
    const candidate = recorder;
    const activeRecorder = recordingPairIsActive(candidate, currentAttempt)
      ? candidate
      : null;
    if (
      requestedStop === null &&
      !recordingFailureRequested &&
      configured.record &&
      !activeRecorder
    ) {
      stopForRecordingFailure(
        currentAttempt,
        `Attempt ${currentAttempt} cannot become active without both recorder processes`,
        candidate,
      );
    }
    const initialCaptureBoundary = mode === "start" && configured.record
      ? activeRecorder
      : null;
    const nowWall = initialCaptureBoundary?.captureStartedWallMs ?? Date.now();
    const nowMono = initialCaptureBoundary?.captureStartedMono ?? process.hrtime.bigint();
    const activeStartedElapsedMs = mode === "start"
      ? prior.elapsedMs
      : state.timeSnapshot(nowWall, nowMono).elapsedMs;
    const activated = activateTimedAttempt({
      stopRequested: requestedStop !== null || recordingFailureRequested,
      recordingRequired: configured.record,
      recordingActive: activeRecorder !== null,
      activate: () => {
        if (mode === "start") {
          state.start(prior.runId, nowWall, nowMono, {
            elapsedMs: prior.elapsedMs,
            startedAt: prior.startedAt,
            tokens: prior.tokens,
            providerTokenCursor: prior.tokenCursor ?? prior.tokens,
            progress: prior.progress,
          });
        } else {
          state.resume(currentAttempt, nowWall, nowMono);
        }
      },
    });
    return activated
      ? {
          activeStartedAt: new Date(nowWall).toISOString(),
          activeStartedElapsedMs,
        }
      : null;
  };
  const reconcileMedia = async (
    configured: RunCheckpoint["options"],
    currentAttempt: number,
  ): Promise<boolean> => await withMediaOperation(async () => {
    if (configured.record || configured.virtualCamera) {
      await ensureVirtualDashboardUnlocked();
    }
    if (!configured.record) await stopRecordingUnlocked();
    const recordingNeedsRestart = configured.record
      ? await startRecordingUnlocked(currentAttempt, configured, false)
      : false;
    if (
      virtualCamera &&
      (!configured.virtualCamera || virtualCamera.device !== configured.virtualCameraDevice)
    ) {
      await stopVirtualCameraUnlocked();
    }
    if (configured.virtualCamera) {
      await startCameraOutputUnlocked(configured, false);
    }
    return recordingNeedsRestart;
  });

  const stopHoldingOverlay = async () => {
    const overlay = holdingOverlay;
    holdingOverlay = null;
    if (!overlay || overlay.exitCode !== null) return;
    signalProcessGroup(overlay, "SIGTERM");
    await Promise.race([once(overlay, "exit"), delay(2_000)]).catch(() => undefined);
    if (overlay.exitCode === null) signalProcessGroup(overlay, "SIGKILL");
  };

  const inspectDiagnostic = (text: string) => {
    if (
      credential.mode === "chatgpt-pool" &&
      isChatGptModelUnsupportedError(text)
    ) {
      unsupportedChatGptModel =
        checkpointStore.snapshot().options.model ?? "gpt-6-astra";
    }
    if (!isQuotaError(text)) return;
    quotaExhausted = true;
    const resetAt = extractQuotaResetAtFromText(text);
    if (resetAt !== null && resetAt > Date.now()) {
      quotaResetAtMs = Math.max(quotaResetAtMs ?? 0, resetAt);
    }
  };
  const activateApiKeyFallback = async (): Promise<boolean> => {
    const configuredModel =
      checkpointStore.snapshot().options.model ?? "gpt-6-astra";
    if (
      credential.mode !== "chatgpt-pool" ||
      unsupportedChatGptModel !== configuredModel
    ) {
      return false;
    }
    apiKeyCredential = await resolveApiKeyCredential();
    if (!apiKeyCredential) return false;
    await prepareApiKeyHome();
    const fallbackCredential = publicApiKeyCredential(apiKeyCredential);
    quotaExhausted = false;
    quotaResetAtMs = null;
    reservePauseRequested = false;
    accountRotationRequested = false;
    configurationRestartRequested = true;
    exitDescription = `The selected model requires ${fallbackCredential.label}`;
    await checkpointStore.update({ credential: fallbackCredential });
    credential = fallbackCredential;
    await audit.append("credential.fallback", {
      attempt,
      mode: credential.mode,
      provider: credential.provider,
      label: credential.label,
      reason: "chatgpt-model-unsupported",
    });
    controller?.publishTranscript({
      type: "runner.credential_fallback",
      provider: credential.provider,
      label: credential.label,
      message: `ChatGPT does not support this model; continuing the same thread with ${credential.label}.`,
    });
    return true;
  };
  const inspectEvent = async (event: unknown) => {
    const resetAt = extractQuotaResetAt(event);
    if (resetAt !== null && resetAt > Date.now()) {
      quotaResetAtMs = Math.max(quotaResetAtMs ?? 0, resetAt);
    }
    const rateLimits = extractRateLimits(event);
    if (accountPool && activeAccountId && rateLimits) {
      await accountPool.update(activeAccountId, rateLimits);
      if (accountPool.shouldStopForReserve(activeAccountId)) {
        reservePauseRequested = true;
        quotaExhausted = true;
        const account = accountPool.snapshot().accounts.find((entry) => entry.id === activeAccountId);
        exitDescription = account
          ? `Stopped at configured reserve for ${account.email} (${account.reserveFiveHourPercent}% five-hour, ${account.reserveWeeklyPercent}% weekly)`
          : "Stopped at the configured account reserve";
        controller?.publishTranscript({
          type: "runner.account_reserve",
          message: exitDescription,
        });
        stopCodex();
      }
    }
  };
  const stopCodexAfterThreadSaved = () => {
    if (!codex || codex.exitCode !== null) return;
    if (checkpointStore.snapshot().threadId) {
      stopCodex();
      return;
    }
    configurationRestartAwaitingThread = true;
  };
  const requestCodexRestart = (message: string) => {
    configurationRestartRequested = true;
    exitDescription = message;
    controller?.publishTranscript({
      type: "runner.configuration_restart",
      message: `${message}; restarting Codex on the same conversation thread.`,
    });
    stopCodexAfterThreadSaved();
  };
  const applyRuntimeConfiguration = async () => {
    if (runtimeConfigBusy) return;
    runtimeConfigBusy = true;
    let request: Awaited<ReturnType<typeof readRuntimeConfigRequest>> = null;
    let previous: RunCheckpoint["options"] | null = null;
    let previousProfiles = accountProfiles;
    let previousAccountPool = accountPool;
    let accountsReconfigured = false;
    let mediaReconciled = false;
    let configurationCommitted = false;
    try {
      request = await readRuntimeConfigRequest(runDirectory);
      if (!request) return;
      previous = checkpointStore.snapshot().options;
      const next = { ...previous, ...request.patch };
      const modelChanged = request.patch.model !== undefined &&
        request.patch.model !== previous.model;
      const goalChanged = request.patch.goal !== undefined &&
        request.patch.goal !== previous.goal;
      const searchChanged = request.patch.webSearchEnabled !== undefined &&
        request.patch.webSearchEnabled !== previous.webSearchEnabled;
      const browserChanged = request.patch.browserUseEnabled !== undefined &&
        request.patch.browserUseEnabled !== previous.browserUseEnabled;
      const toolGuidanceChanged = request.patch.toolCreationGuidance !== undefined &&
        request.patch.toolCreationGuidance !== previous.toolCreationGuidance;
      const nextCredential = credentialAfterModelChange(
        credential,
        previous.model,
        request.patch.model,
      );

      if (request.patch.accountPolicies) {
        const refreshedProfiles = await discoverCodexAccounts();
        await Promise.all(
          refreshedProfiles.map((profile) =>
            inheritCodexConfiguration(profile.home, codexHome),
          ),
        );
        if (refreshedProfiles.length > 0) {
          if (accountPool) {
            await accountPool.reconfigure(refreshedProfiles, request.patch.accountPolicies);
          } else {
            accountPool = await AccountPool.open(
              runDirectory,
              refreshedProfiles,
              request.patch.accountPolicies,
            );
          }
        } else {
          accountPool = null;
        }
        accountProfiles = refreshedProfiles;
        accountsReconfigured = true;
      }

      mediaReconciled = true;
      const recordingNeedsRestart = await reconcileMedia(next, attempt);

      let nextRetryAt = checkpointStore.snapshot().retryAt;
      if (
        request.patch.quotaWaitMs !== undefined &&
        outcomePhase === "waiting_quota" &&
        quotaFallbackStartedAtMs !== null
      ) {
        quotaResetAtMs = quotaFallbackStartedAtMs + next.quotaWaitMs;
        nextRetryAt = new Date(quotaResetAtMs).toISOString();
        retryAt = nextRetryAt;
        if (accountPool && activeAccountId) {
          await accountPool.markBlocked(activeAccountId, quotaResetAtMs);
        }
        runtimeConfigGeneration += 1;
      }

      if (
        accountsReconfigured &&
        credential.mode === "chatgpt-pool" &&
        state.snapshot().status !== "running" &&
        accountPool
      ) {
        const choice = accountPool.choose();
        await accountPool.persist();
        if (choice.account && outcomePhase === "waiting_quota") {
          nextRetryAt = new Date().toISOString();
          retryAt = nextRetryAt;
          runtimeConfigGeneration += 1;
        }
      }

      if (
        modelChanged &&
        credential.mode === "api-key" &&
        state.snapshot().status !== "running"
      ) {
        nextRetryAt = new Date().toISOString();
        retryAt = nextRetryAt;
        runtimeConfigGeneration += 1;
      }

      await checkpointStore.update({
        options: next,
        credential: nextCredential,
        ...(nextRetryAt !== checkpointStore.snapshot().retryAt
          ? { retryAt: nextRetryAt }
          : {}),
      });
      configurationCommitted = true;
      credential = nextCredential;
      if (modelChanged) unsupportedChatGptModel = null;
      state.setModel(next.model ?? "gpt-6-astra");
      state.setGoal(next.goal ?? DEFAULT_GOAL);

      let restartCodex = codex !== null && (
        modelChanged ||
        goalChanged ||
        searchChanged ||
        browserChanged ||
        toolGuidanceChanged ||
        (request.patch.reasoningEffort !== undefined &&
          request.patch.reasoningEffort !== previous.reasoningEffort)
      );
      if (recordingNeedsRestart && codex !== null) restartCodex = true;
      const restartGameRuntime = request.patch.launchMode !== undefined &&
        request.patch.launchMode !== previous.launchMode;

      if (accountsReconfigured && activeAccountId) {
        const activeStillEnabled = accountPool?.snapshot().accounts.some(
          (entry) => entry.id === activeAccountId,
        ) === true;
        if (!activeStillEnabled) {
          accountRotationRequested = true;
          quotaExhausted = true;
          exitDescription = "The active Codex account was disabled by the updated policy";
          stopCodexAfterThreadSaved();
        } else if (accountPool?.shouldStopForReserve(activeAccountId)) {
          reservePauseRequested = true;
          quotaExhausted = true;
          exitDescription = "The active Codex account reached the updated reserve limit";
          stopCodexAfterThreadSaved();
        }
      }

      if (restartCodex) {
        hotCodexConfigurationRestartRequested =
          !recordingNeedsRestart && !restartGameRuntime;
        requestCodexRestart(
          recordingNeedsRestart
            ? "Starting a new recording part"
            : "Applying updated agent configuration",
        );
      }

      if (restartGameRuntime) {
        configurationRestartRequested = true;
        requestedStop = "restart";
        exitDescription = "Applying updated game launch mode";
        controller?.cancelPendingActions();
        controller?.publishTranscript({
          type: "runner.game_runtime_restart",
          message: "Launch mode changed; sealing the snapshot and restarting the private game runtime.",
        });
        stopCodexAfterThreadSaved();
      }

      const appliedFields = Object.keys(request.patch).filter((field) => field !== "offlineMode");
      const deferredFields: string[] = [];
      await writeRuntimeConfigAck(runDirectory, {
        version: 1,
        id: request.id,
        appliedAt: new Date().toISOString(),
        appliedFields,
        deferredFields,
        codexRestarted: restartCodex,
        error: null,
      });
      await audit.append("configuration.updated", {
        requestId: request.id,
        appliedFields,
        deferredFields,
        codexRestarted: restartCodex,
      });
      controller?.publishTranscript({
        type: "runner.configuration_updated",
        message: restartGameRuntime
          ? "Configuration saved; the private game runtime is restarting now."
          : "Configuration saved and applied.",
        appliedFields,
        deferredFields,
      });
    } catch (error) {
      if (!configurationCommitted && mediaReconciled && previous) {
        const rollbackNeedsRestart = await reconcileMedia(previous, attempt)
          .catch(() => false);
        if (rollbackNeedsRestart && codex !== null) {
          requestCodexRestart("Restoring recording after a configuration failure");
        }
      }
      if (!configurationCommitted && accountsReconfigured && previous) {
        accountProfiles = previousProfiles;
        accountPool = previousAccountPool;
        if (accountPool) {
          await accountPool.reconfigure(
            previousProfiles,
            previous.accountPolicies ?? [],
          ).catch(() => undefined);
        }
      }
      if (request && !configurationCommitted) {
        await writeRuntimeConfigAck(runDirectory, {
          version: 1,
          id: request.id,
          appliedAt: new Date().toISOString(),
          appliedFields: [],
          deferredFields: [],
          codexRestarted: false,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
      }
      await audit.append("configuration.warning", String(error));
    } finally {
      runtimeConfigBusy = false;
    }
  };
  const checkAccountRotation = async () => {
    if (!accountPool || !activeAccountId || accountRotationRequested) return;
    const choice = accountPool.choose();
    if (!choice.account || choice.account.id === activeAccountId) return;
    accountRotationRequested = true;
    exitDescription = "A more recently reset Codex account is now eligible";
    await accountPool.persist();
    const accountLabel = path.basename(choice.account.home);
    await audit.append("account.rotation_due", {
      attempt,
      account: accountLabel,
      reason: "newer-five-hour-reset",
    });
    controller?.publishTranscript({
      type: "runner.account_rotation",
      account: accountLabel,
      message: `A newer allowance reset is available; snapshotting and switching to ${accountLabel}.`,
    });
    stopCodex();
  };
  const checkPower = async () => {
    if (powerCheckBusy) return;
    powerCheckBusy = true;
    try {
      lastPowerState = await readPowerState();
      if (
        shouldSnapshotForLowBattery(lastPowerState) &&
        !powerPauseRequested
      ) {
        powerPauseRequested = true;
        const message = `Battery is ${lastPowerState.batteryPercent}%; preserving a snapshot until power returns.`;
        powerPauseReason = `Battery at ${lastPowerState.batteryPercent}%; snapshot saved until wake or external power`;
        controller?.publishTranscript({ type: "runner.power_pause", message });
        await audit.append("power.low", {
          ...lastPowerState,
          thresholdPercent: 3,
        });
        stopCodex();
      }
    } finally {
      powerCheckBusy = false;
    }
  };
  const onInterrupt = () => {
    requestedStop = "pause";
    exitDescription = "Paused by SIGINT";
    startupAbortController.abort();
    interruptActiveTiming(state, () => {
      controller?.cancelPendingActions();
      stopCodex();
    });
  };
  const onTerminate = () => {
    requestedStop = "restart";
    exitDescription = "Interrupted by shutdown or service restart";
    startupAbortController.abort();
    interruptActiveTiming(state, () => {
      controller?.cancelPendingActions();
      stopCodex();
    });
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  runtimeConfigPoll = setInterval(() => {
    void applyRuntimeConfiguration();
  }, 250);
  runtimeConfigPoll.unref();

  try {
    const steamStatus = await runCommand("pgrep", ["-x", "steam"]);
    if (steamStatus.code === 0) {
      throw new Error(
        "Steam is already running. Close it before a headless challenge so it cannot forward the game to the physical desktop.",
      );
    }
    if (prior.options.isolateSaves && isParabox) {
      if (prior.savePrepared) await saveGuard.resume();
      else {
        await saveGuard.prepare();
        await checkpointStore.update({ savePrepared: true });
        await audit.append("save.isolated", { directory: paths.saveDirectory });
      }
    }

    virtualGame = await startVirtualGame({
      rootDirectory,
      runtimeDirectory,
      game: selectedGame,
      gpuPreference: prior.options.gpuPreference,
      offlineMode: prior.options.offlineMode ?? false,
      ...(prior.options.launchMode
        ? { launchMode: prior.options.launchMode }
        : {}),
      signal: startupAbortController.signal,
    });
    const activeGame = new X11GameAdapter({
      display: virtualGame.display,
      frameDirectory,
      keypressCommand: virtualGame.keypressCommand,
      titlePattern: gameTitlePattern(selectedGame),
      compositorScreenshot: virtualGame.compositorScreenshot,
    });
    game = activeGame;
    const gameStartupTimeoutMs = isParabox ? 120_000 : 5 * 60_000;
    gameWindow = await waitForGame(
      activeGame,
      gameStartupTimeoutMs,
      () => requestedStop !== null,
    );
    await activeGame.waitForVisibleFrame(
      gameStartupTimeoutMs,
      () => requestedStop !== null,
    );
    await audit.append("game.ready", {
      ...gameWindow,
      backend: "cage-headless-xwayland",
      display: virtualGame.display,
    });

    const resumeFrame = isColdResume
      ? await loadRuntimeSnapshot(runDirectory, prior.attempt)
      : null;
    if (isColdResume) {
      const pausedAtWall = Date.now();
      const pausedAtMono = process.hrtime.bigint();
      state.start(prior.runId, pausedAtWall, pausedAtMono, {
        elapsedMs: prior.elapsedMs,
        startedAt: prior.startedAt,
        tokens: prior.tokens,
        providerTokenCursor: prior.tokenCursor ?? prior.tokens,
        progress: prior.progress,
      });
      state.pause(pausedAtWall, pausedAtMono);
      if (resumeFrame) {
        holdingOverlay = await startHoldingOverlay(
          runtimeDirectory,
          virtualGame.display,
          resumeFrame,
        );
      }
    }

    const activeController = new ArenaController({
      state,
      game: activeGame,
      liveCaptureWayland: virtualGame.captureWayland,
      ...(resumeFrame ? { initialFrame: resumeFrame } : {}),
      port: prior.options.port,
      webRoot: path.join(rootDirectory, "web"),
      onGameAction: async (phase) => {
        if (phase === "after") await stopHoldingOverlay();
      },
      onTranscript: async (record) => {
        await audit.appendRaw("transcript.jsonl", JSON.stringify(record));
      },
      supervisorProvider: () => {
        const checkpoint = checkpointStore.snapshot();
        return {
          active: true,
          checkpoint,
          currentCredential: currentCredentialStatus(
            checkpoint.credential,
            accountPool?.snapshot() ?? null,
          ),
          accountPool: accountPool?.snapshot() ?? null,
          recording: {
            enabled: checkpoint.options.record,
            active: mediaState.recordingActive,
            parts: checkpoint.recordings.length,
            lastError: mediaState.recordingError ?? mediaState.lastError ?? null,
          },
          virtualCamera: {
            enabled: checkpoint.options.virtualCamera,
            active: mediaState.virtualCameraActive,
            device: mediaState.virtualCameraDevice ??
              checkpoint.options.virtualCameraDevice ?? null,
            lastError: mediaState.virtualCameraError ?? mediaState.lastError ?? null,
          },
        };
      },
    });
    controller = activeController;
    const url = await activeController.listen();
    controllerUrl = url;
    console.log(`Director dashboard: ${url}`);
    await audit.append("controller.ready", { url });
    activeController.publishTranscript({
      type: "runner.ready",
      message: "Hidden game and challenge controller are ready.",
    });
    if (!isColdResume) {
      await fetch(new URL("/internal/observe", url), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${activeController.controlToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
    }

    if (prior.options.openDashboard) {
      browser = spawn(
        "google-chrome-stable",
        [
          `--user-data-dir=${path.join(runtimeDirectory, "chrome-profile")}`,
          "--no-first-run",
          "--disable-session-crashed-bubble",
          `--app=${url}/?compact=1`,
        ],
        { stdio: "ignore" },
      );
      await audit.append("monitor.opened", { url, physicalDesktop: true });
    }

    const initialRuntimeOptions = checkpointStore.snapshot().options;
    if (initialRuntimeOptions.record || initialRuntimeOptions.virtualCamera) {
      await ensureVirtualDashboard();
    }

    await startCameraOutput(true);

    let activationBoundary: {
      activeStartedAt: string;
      activeStartedElapsedMs: number;
    } | null;
    if (isColdResume) {
      const restoredFrame = await activeGame.capture();
      activeController.publishFrame(restoredFrame);
      await startRecording(attempt, true);
      activationBoundary = activateAttemptTiming("resume", attempt);
      if (!activationBoundary) throw new Error(exitDescription);
      await audit.append("runtime.snapshot.restored", {
        attempt,
        method: "durable-save-and-codex-thread",
        threadId: prior.threadId,
        holdingFrame: resumeFrame !== null,
        titleVisibleInRecording: false,
      });
    } else {
      await startRecording(attempt, true);
      activationBoundary = activateAttemptTiming("start", attempt);
      if (!activationBoundary) throw new Error(exitDescription);
    }
    const finishPromise = once(state, "finished").then(
      ([snapshot]) => snapshot as ReturnType<ChallengeState["snapshot"]>,
    );
    await checkpointStore.update({
      phase: "running",
      startedAt: state.timeSnapshot().startedAt,
    });
    await audit.append(attempt === 1 ? "challenge.started" : "challenge.resumed", {
      attempt,
      threadId: prior.threadId,
      ...activationBoundary,
      snapshot: state.snapshot(),
    });
    const liveProgress = isParabox
      ? await readBestProgress(paths.saveDirectory)
      : null;
    if (liveProgress) state.ingestSave(liveProgress.text);
    if (state.snapshot().status !== "completed") {
      if (isParabox) {
        savePoll = setInterval(() => {
          void readBestProgress(paths.saveDirectory).then((progress) => {
            if (!progress) return;
            state.ingestSave(progress.text);
          });
        }, 350);
      }
      checkpointPoll = setInterval(() => {
        if (checkpointBusy) return;
        checkpointBusy = true;
        checkpointWork.current = persistAttemptCheckpoint(
          checkpointStore,
          state,
          prior.options.isolateSaves && isParabox ? saveGuard : null,
        )
          .then(adoptCompletedRecordingPairs)
          .catch((error: unknown) => {
            void audit.append("checkpoint.warning", String(error));
          })
          .finally(() => {
            checkpointBusy = false;
          });
      }, 5_000);
      gameHealthPoll = setInterval(() => {
        if (gameHealthBusy || requestedStop !== null) return;
        gameHealthBusy = true;
        void activeGame.hasGameWindow()
          .then(async (available) => {
            missingGameHealthChecks = available ? 0 : missingGameHealthChecks + 1;
            if (missingGameHealthChecks < 3 || requestedStop !== null) return;
            requestedStop = "game-exit";
            exitDescription = "The selected game window exited unexpectedly";
            activeController.cancelPendingActions();
            activeController.publishTranscript({
              type: "runner.game_exited",
              message: exitDescription,
            });
            await audit.append("game.exited", { attempt, message: exitDescription });
            stopCodex();
          })
          .catch((error: unknown) => {
            void audit.append("game.health.warning", String(error));
          })
          .finally(() => {
            gameHealthBusy = false;
          });
      }, 2_000);
      await checkPower();
      powerPoll = setInterval(() => {
        void checkPower().catch((error: unknown) => {
          void audit.append("power.warning", String(error));
        });
      }, 5_000);
      accountPoll = setInterval(() => {
        void checkAccountRotation().catch((error: unknown) => {
          void audit.append("account.rotation.warning", String(error));
        });
      }, 5_000);

      while (state.snapshot().status !== "completed" && requestedStop === null) {
        quotaExhausted = false;
        quotaResetAtMs = null;
        reservePauseRequested = false;
        accountRotationRequested = false;
        configurationRestartRequested = false;
        configurationRestartAwaitingThread = false;
        hotCodexConfigurationRestartRequested = false;
        quotaFallbackStartedAtMs = null;
        unsupportedChatGptModel = null;
        activeAccountId = null;
        exitDescription = "Codex exited before completion";
        let activeCodexHome = codexHome;
        if (credential.mode === "api-key" && !powerPauseRequested) {
          activeCodexHome = await prepareApiKeyHome();
        } else if (accountPool && !powerPauseRequested) {
          const choice = accountPool.choose();
          await accountPool.persist();
          if (choice.account) {
            activeAccountId = choice.account.id;
            activeCodexHome = choice.account.home;
            const accountLabel = path.basename(choice.account.home);
            await audit.append("account.selected", {
              attempt,
              account: accountLabel,
              limitedByReserve: choice.limitedByReserve,
            });
            activeController.publishTranscript({
              type: "runner.account_selected",
              account: accountLabel,
              reserveFiveHourPercent: choice.account.reserveFiveHourPercent,
              reserveWeeklyPercent: choice.account.reserveWeeklyPercent,
            });
          } else {
            quotaExhausted = true;
            quotaResetAtMs = choice.retryAtMs;
            exitDescription = "No account is currently eligible under the configured reserve limits";
          }
        }
        if (
          !powerPauseRequested &&
          (credential.mode === "api-key" || !accountPool || activeAccountId)
        ) {
          const part = String(attempt).padStart(4, "0");
          codexInvocation += 1;
          const invocation = codexInvocation === 1
            ? ""
            : `-invocation-${String(codexInvocation).padStart(4, "0")}`;
          const currentThreadId = checkpointStore.snapshot().threadId;
          const currentOptions = checkpointStore.snapshot().options;
          if (currentThreadId) {
            await ensureCodexThreadInBase(
              currentThreadId,
              primaryCodexHome,
              [...accountProfiles, { home: apiKeyHome }],
            );
          }
          const args = codexArguments({
            mcpEntry,
            arenaUrl: url,
            controlToken: activeController.controlToken,
            reasoningEffort: currentOptions.reasoningEffort,
            model: currentOptions.model ?? "gpt-6-astra",
            webSearchEnabled: currentOptions.webSearchEnabled === true,
            browserUseEnabled: currentOptions.browserUseEnabled === true,
            ...(credential.mode === "api-key"
              ? { modelProvider: credential.provider }
              : {}),
            prompt: currentThreadId
              ? continuationPrompt(currentOptions.goal ?? DEFAULT_GOAL, currentOptions)
              : initialPrompt(
                  currentOptions.goal ?? DEFAULT_GOAL,
                  selectedGame.name,
                  currentOptions,
                ),
            ...(currentThreadId ? { resumeThreadId: currentThreadId } : {}),
          });
          const codexStartedAtMs = Date.now();
          await writeFile(
            path.join(runDirectory, `codex-command-part-${part}${invocation}.json`),
            `${JSON.stringify({ command: CODEX_COMMAND, args: redactControlToken(args) }, null, 2)}\n`,
          );
          codex = spawn(CODEX_COMMAND, args, {
            cwd: workDirectory,
            env: codexEnvironment(activeCodexHome, primaryCodexHome),
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const activeCodex = codex;
          activeCodex.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8").trimEnd();
            inspectDiagnostic(text);
            void audit.appendRaw(`codex-stderr-part-${part}.log`, text);
            for (const line of text.split(/\r?\n/).filter(Boolean)) {
              activeController.publishTranscript({ type: "stderr", message: line });
            }
          });
          activeController.publishTranscript({
            type: "process.started",
            process: CODEX_COMMAND,
            attempt,
          });

          const stdoutLines = readline.createInterface({ input: activeCodex.stdout! });
          stdoutLines.on("line", (line) => {
            const task = (async () => {
              await audit.appendRaw("codex-exec.jsonl", line);
              let event: unknown;
              try {
                event = JSON.parse(line);
              } catch {
                return;
              }
              await inspectEvent(event);
              state.ingestCodexEvent(event);
              const visible = publicTranscriptEvent(event);
              if (visible) activeController.publishTranscript(visible);
              const root = event as Record<string, unknown>;
              if (root.type === "error" || root.type === "turn.failed") {
                inspectDiagnostic(line);
              }
              if (
                root.type === "thread.started" &&
                typeof root.thread_id === "string"
              ) {
                await checkpointStore.update({ threadId: root.thread_id });
                for (const activeTailer of tailers) activeTailer.stop();
                tailers.clear();
                const tailer = new RolloutTailer(
                  root.thread_id,
                  [
                    path.join(activeCodexHome ?? primaryCodexHome, "sessions"),
                    path.join(primaryCodexHome, "sessions"),
                    path.join(os.homedir(), ".codex", "sessions"),
                    path.join(apiKeyHome, "sessions"),
                    ...accountProfiles.map((profile) => path.join(profile.home, "sessions")),
                  ],
                  codexStartedAtMs,
                );
                tailers.add(tailer);
                const tailerTask = tailer.follow(async (rolloutEvent, raw) => {
                  await inspectEvent(rolloutEvent);
                  state.ingestCodexEvent(rolloutEvent);
                  if (extractTokenUsage(rolloutEvent)) {
                    await audit.appendRaw("codex-usage.jsonl", raw);
                  }
                });
                tailerTasks.add(tailerTask);
                void tailerTask
                  .catch(() => undefined)
                  .finally(() => tailerTasks.delete(tailerTask));
                if (configurationRestartAwaitingThread) {
                  configurationRestartAwaitingThread = false;
                  stopCodex();
                }
              }
            })();
            eventTasks.add(task);
            void task
              .catch(() => undefined)
              .finally(() => eventTasks.delete(task));
          });

          let codexExitedWhileRunning = false;
          const exitPromise = once(activeCodex, "exit").then(([code, signal]) => {
            codexExitedWhileRunning = state.snapshot().status === "running";
            if (!configurationCanReloadContinuously()) {
              interruptActiveTiming(state, () => undefined);
            }
            return {
              code: typeof code === "number" ? code : null,
              signal: typeof signal === "string" ? signal : null,
            };
          });
          void exitPromise.then((exit) => {
            activeController.publishTranscript({
              type: "process.exited",
              process: CODEX_COMMAND,
              ...exit,
            });
          });
          const first = await Promise.race([
            exitPromise.then((exit) => ({ type: "exit" as const, exit })),
            finishPromise.then((snapshot) => ({ type: "finish" as const, snapshot })),
          ]);
          if (
            first.type === "exit" &&
            codexExitedWhileRunning &&
            !reservePauseRequested &&
            !accountRotationRequested &&
            !configurationRestartRequested
          ) {
            exitDescription = `Codex exited before completion (code=${first.exit.code}, signal=${first.exit.signal})`;
          } else if (
            first.type === "finish" &&
            first.snapshot.status === "completed"
          ) {
            const exit = await Promise.race([
              exitPromise,
              delay(8_000).then(() => null),
            ]);
            if (!exit && activeCodex.exitCode === null) activeCodex.kill("SIGINT");
          }
          if (activeCodex.exitCode === null) {
            await Promise.race([exitPromise, delay(5_000)]);
          }
          await Promise.allSettled([...eventTasks]);
          await activateApiKeyFallback();
          codex = null;
        }
        if (configurationCanReloadContinuously()) {
          await persistAttemptCheckpoint(
            checkpointStore,
            state,
            prior.options.isolateSaves && isParabox ? saveGuard : null,
          );
          await audit.append("codex.configuration_reloaded", {
            attempt,
            threadId: checkpointStore.snapshot().threadId,
            runtimePreserved: true,
            recordingPreserved: recorder !== null,
            virtualCameraPreserved: virtualCamera !== null,
            snapshot: state.snapshot(),
          });
          activeController.publishTranscript({
            type: "runner.configuration_reloaded",
            message:
              "Agent configuration reloaded on the same thread; game, timer, recording, and virtual camera remained live.",
          });
          continue;
        }
        if (state.snapshot().status !== "completed") state.pause();
        await stopRecording();
        await stopVirtualCamera();

        if (state.snapshot().status === "completed") break;
        const runtimeFrame = requestedStop === "game-exit"
          ? null
          : await captureRuntimeSnapshot(
              runDirectory,
              attempt,
              activeGame,
              audit,
            );
        if (runtimeFrame) activeController.publishFrame(runtimeFrame);
        await persistAttemptCheckpoint(
          checkpointStore,
          state,
          prior.options.isolateSaves && isParabox ? saveGuard : null,
        );

        if (requestedStop !== null) break;
        let rotateAccountImmediately = configurationRestartRequested;
        if (
          accountPool &&
          activeAccountId &&
          (quotaExhausted || accountRotationRequested)
        ) {
          if (!reservePauseRequested && !accountRotationRequested) {
            if (quotaResetAtMs === null) {
              quotaFallbackStartedAtMs = Date.now();
              quotaResetAtMs = quotaFallbackStartedAtMs +
                checkpointStore.snapshot().options.quotaWaitMs;
            }
            await accountPool.markBlocked(activeAccountId, quotaResetAtMs);
          }
          const nextAccount = accountPool.choose();
          await accountPool.persist();
          rotateAccountImmediately =
            accountRotationRequested ||
            (nextAccount.account !== null &&
              nextAccount.account.id !== activeAccountId);
          if (!nextAccount.account && nextAccount.retryAtMs !== null) {
            quotaResetAtMs = nextAccount.retryAtMs;
          }
        }
        if (quotaExhausted && !rotateAccountImmediately && quotaResetAtMs === null) {
          quotaFallbackStartedAtMs = Date.now();
          quotaResetAtMs = quotaFallbackStartedAtMs +
            checkpointStore.snapshot().options.quotaWaitMs;
        }
        const recordingRetry = recordingFailureRequested
          ? recordingFailureOutcome(attempt, exitDescription)
          : null;
        outcomePhase = powerPauseRequested
          ? "waiting_power"
          : rotateAccountImmediately
            ? "waiting_retry"
          : quotaExhausted
            ? "waiting_quota"
            : recordingRetry?.phase ?? "waiting_retry";
        retryAt = powerPauseRequested
          ? null
          : rotateAccountImmediately
            ? new Date().toISOString()
          : quotaExhausted
            ? quotaRetryAt(
                Date.now(),
                checkpointStore.snapshot().options.quotaWaitMs,
                quotaResetAtMs,
              )
            : recordingRetry?.retryAt ??
              new Date(Date.now() + retryDelayMs(attempt)).toISOString();
        reason = powerPauseRequested
          ? powerPauseReason
          : rotateAccountImmediately
            ? configurationRestartRequested
              ? "Applying updated model configuration"
              : "Switching to another eligible Codex account"
            : recordingRetry?.reason ?? exitDescription;
        const waitingSnapshot = state.snapshot();
        await checkpointStore.update({
          phase: outcomePhase,
          pid: process.pid,
          pidStartTicks: processStartTicks(),
          retryAt,
          reason,
          elapsedMs: waitingSnapshot.time.elapsedMs,
          startedAt: waitingSnapshot.time.startedAt,
          tokens: waitingSnapshot.tokens,
          progress: waitingSnapshot.progress,
        });
        await audit.append("attempt.finished", {
          attempt,
          phase: outcomePhase,
          retryAt,
          reason,
          runtimePreserved: true,
          activeEndedAt: waitingSnapshot.time.endedAt,
          activeEndedElapsedMs: waitingSnapshot.time.elapsedMs,
          snapshot: waitingSnapshot,
        });
        if (checkpointStore.snapshot().recordings.length > 0 || checkpointStore.snapshot().options.record) {
          try {
            productionVideo = await assembleRecordings(runDirectory);
            await audit.append("recording.assembled", productionVideo);
          } catch (error) {
            await audit.append("recording.assembly.warning", String(error));
          }
        }
        activeController.publishTranscript({
          type: "runner.waiting",
          phase: outcomePhase,
          retryAt,
          message: powerPauseRequested
            ? "Game snapshot preserved; Codex will resume when power is safe."
            : `Game snapshot preserved; Codex will resume at ${retryAt}.`,
        });

        if (!powerPauseRequested && retryAt) {
          while (requestedStop === null && !powerPauseRequested) {
            const generation = runtimeConfigGeneration;
            const activeRetryAt = checkpointStore.snapshot().retryAt ?? retryAt;
            await waitUntil(
              Date.parse(activeRetryAt),
              () =>
                requestedStop !== null ||
                powerPauseRequested ||
                runtimeConfigGeneration !== generation,
            );
            retryAt = checkpointStore.snapshot().retryAt ?? retryAt;
            if (runtimeConfigGeneration === generation) break;
          }
        }
        await checkPower();
        if (powerPauseRequested && requestedStop === null) {
          outcomePhase = "waiting_power";
          retryAt = null;
          reason = powerPauseReason;
          await checkpointStore.update({
            phase: outcomePhase,
            retryAt,
            reason,
          });
          activeController.publishTranscript({
            type: "runner.waiting",
            phase: outcomePhase,
            retryAt,
            message: "Game snapshot preserved; Codex will resume when power is safe.",
          });
          await waitForPower(() => requestedStop !== null);
        }
        if (requestedStop !== null) break;
        const resumedFromPower = powerPauseRequested;
        powerPauseRequested = false;
        recordingFailureRequested = false;
        attempt += 1;
        retryAt = null;
        reason = null;
        const resumedOptions = checkpointStore.snapshot().options;
        if (resumedOptions.record || resumedOptions.virtualCamera) {
          await ensureVirtualDashboard();
        }
        await startRecording(attempt, true);
        await startCameraOutput(true);
        const resumedBoundary = activateAttemptTiming("resume", attempt);
        if (!resumedBoundary) break;
        retryAt = null;
        reason = null;
        await checkpointStore.update({
          phase: "running",
          attempt,
          pid: process.pid,
          pidStartTicks: processStartTicks(),
          retryAt: null,
          reason: null,
        });
        await audit.append("challenge.resumed", {
          attempt,
          threadId: checkpointStore.snapshot().threadId,
          method: "preserved-live-runtime",
          ...resumedBoundary,
          snapshot: state.snapshot(),
        });
        activeController.publishTranscript({
          type: "runner.resumed",
          message: resumedFromPower
            ? "Power is safe; continuing the preserved game runtime."
            : "Quota/reset wait ended; continuing the preserved game runtime.",
          attempt,
        });
      }
    }
    if (state.snapshot().status === "completed") {
      outcomePhase = "completed";
    } else if (requestedStop === "pause") {
      outcomePhase = "paused";
      reason = "Paused by SIGINT";
    } else if (requestedStop === "restart") {
      outcomePhase = "waiting_retry";
      retryAt = new Date().toISOString();
      reason = exitDescription === "Codex exited before completion"
        ? "Interrupted by shutdown or service restart"
        : exitDescription;
    } else if (requestedStop === "game-exit") {
      outcomePhase = "waiting_retry";
      retryAt = new Date(Date.now() + retryDelayMs(attempt)).toISOString();
      reason = exitDescription;
    } else {
      outcomePhase = state.snapshot().status === "stopped"
        ? outcomePhase
        : "waiting_retry";
      retryAt ??= new Date(Date.now() + retryDelayMs(attempt)).toISOString();
      reason ??= exitDescription;
    }
  } catch (error) {
    if (state.snapshot().status === "running") state.stop();
    reason = error instanceof Error ? error.message : String(error);
    outcomePhase = requestedStop === "pause" ? "paused" : "waiting_retry";
    retryAt = outcomePhase === "waiting_retry"
      ? new Date(
          Date.now() + (requestedStop === "restart" ? 0 : retryDelayMs(attempt)),
        ).toISOString()
      : null;
    controller?.publishTranscript({ type: "runner.error", message: reason });
    await audit.append("run.error", {
      attempt,
      message: reason,
      stack: error instanceof Error ? error.stack : null,
    });
  } finally {
    const cleanupFailures: string[] = [];
    const cleanup = async (component: string, operation: () => void | Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        const message = cleanupErrorText(error);
        cleanupFailures.push(`${component}: ${message}`);
        await audit.append("cleanup.warning", { component, message }).catch(() => undefined);
      }
    };
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    for (const tailer of tailers) tailer.stop();
    await Promise.allSettled([...tailerTasks]);
    if (savePoll) clearInterval(savePoll);
    if (checkpointPoll) clearInterval(checkpointPoll);
    if (gameHealthPoll) clearInterval(gameHealthPoll);
    if (powerPoll) clearInterval(powerPoll);
    if (accountPoll) clearInterval(accountPoll);
    if (runtimeConfigPoll) clearInterval(runtimeConfigPoll);
    if (checkpointWork.current) {
      await checkpointWork.current.catch(() => undefined);
    }
    if (codex?.exitCode === null) codex.kill("SIGINT");
    await cleanup("recording", stopRecording);
    await cleanup("virtual camera", stopVirtualCamera);
    await cleanup("holding overlay", stopHoldingOverlay);
    if (game) await cleanup("game adapter", () => game!.close());
    await delay(500);
    browser?.kill("SIGTERM");
    if (virtualDashboard) {
      await cleanup("director dashboard", () => virtualDashboard!.close());
    }
    if (virtualGame) {
      await cleanup("virtual game", async () => {
        try {
          await virtualGame!.close();
        } catch (firstError) {
          await audit.append("cleanup.retry", {
            component: "virtual game",
            message: cleanupErrorText(firstError),
          }).catch(() => undefined);
          await delay(250);
          try {
            await virtualGame!.close();
          } catch (retryError) {
            throw new AggregateError(
              [firstError, retryError],
              "Virtual game teardown failed twice",
              { cause: firstError },
            );
          }
        }
      });
    }
    if (controller) await cleanup("controller", () => controller!.close());
    if (prior.options.isolateSaves && isParabox) {
      await saveGuard.checkpointChallenge().catch(async (error: unknown) => {
        await audit.append("checkpoint.save.warning", String(error));
      });
    }
    const cleanedOutcome = outcomeAfterCleanup(
      outcomePhase,
      retryAt,
      reason,
      cleanupFailures,
    );
    outcomePhase = cleanedOutcome.phase;
    retryAt = cleanedOutcome.retryAt;
    reason = cleanedOutcome.reason;
    const snapshot = state.snapshot();
    const attemptStarted = snapshot.status !== "idle";
    const checkpointPhase =
      outcomePhase === "completed" && prior.options.isolateSaves && isParabox
        ? "running"
        : outcomePhase;
    await checkpointStore.update({
      phase: checkpointPhase,
      pid: checkpointPhase === "running" ? process.pid : null,
      pidStartTicks:
        checkpointPhase === "running" ? processStartTicks() : null,
      retryAt,
      reason,
      elapsedMs: attemptStarted ? snapshot.time.elapsedMs : prior.elapsedMs,
      startedAt: attemptStarted
        ? snapshot.time.startedAt ?? prior.startedAt
        : prior.startedAt,
      tokens: attemptStarted ? snapshot.tokens : prior.tokens,
      tokenCursor: attemptStarted
        ? state.providerTokenCursorSnapshot()
        : prior.tokenCursor ?? prior.tokens,
      progress: attemptStarted ? snapshot.progress : prior.progress,
    });
    await checkpointStore.flush();
    await audit.append("attempt.finished", {
      attempt,
      phase: outcomePhase,
      retryAt,
      reason,
      activeEndedAt: snapshot.time.endedAt,
      activeEndedElapsedMs: snapshot.time.elapsedMs,
      snapshot,
    });
    if (outcomePhase === "completed" && prior.options.isolateSaves && isParabox) {
      await saveGuard.restore();
      restored = true;
    }
    if (outcomePhase === "completed") {
      await checkpointStore.update({
        phase: "completed",
        pid: null,
        pidStartTicks: null,
      });
      if (checkpointStore.snapshot().recordings.length > 0 || checkpointStore.snapshot().options.record) {
        try {
          productionVideo = await assembleRecordings(runDirectory);
          await audit.append("recording.assembled", productionVideo);
        } catch (error) {
          await audit.append("recording.assembly.warning", String(error));
        }
      }
      await audit.append("challenge.finished", snapshot);
      await audit.finalize({
        ...snapshot,
        attempts: attempt,
        continuity: attempt === 1 ? "continuous" : "resumed",
        wallElapsedMs: Math.max(0, Date.now() - Date.parse(prior.createdAt)),
        inactiveElapsedMs: Math.max(
          0,
          Date.now() - Date.parse(prior.createdAt) - snapshot.time.elapsedMs,
        ),
        recordings: checkpointStore.snapshot().recordings,
        productionVideo,
        savesRestored: restored,
      });
      await clearActiveRun(rootDirectory, runDirectory);
    }
  }
  const finished = checkpointStore.snapshot();
  return {
    runDirectory,
    phase: finished.phase,
    retryAt: finished.retryAt,
    reason: finished.reason,
  };
}

export function cleanupErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof AggregateError) || error.errors.length === 0) return message;
  return `${message}: ${error.errors.map(cleanupErrorText).join("; ")}`;
}

export function interruptActiveTiming(
  state: ChallengeState,
  interrupt: () => void,
  nowWall = Date.now(),
  nowMono = process.hrtime.bigint(),
): void {
  state.pause(nowWall, nowMono);
  interrupt();
}

export function activateTimedAttempt(options: {
  stopRequested: boolean;
  recordingRequired: boolean;
  recordingActive: boolean;
  activate: () => void;
}): boolean {
  if (
    options.stopRequested ||
    (options.recordingRequired && !options.recordingActive)
  ) return false;
  options.activate();
  return true;
}

export function canReloadCodexContinuously(options: {
  hotRestartRequested: boolean;
  stopRequested: boolean;
  powerPauseRequested: boolean;
  recordingFailureRequested: boolean;
  quotaExhausted: boolean;
  reservePauseRequested: boolean;
  accountRotationRequested: boolean;
}): boolean {
  return options.hotRestartRequested &&
    !options.stopRequested &&
    !options.powerPauseRequested &&
    !options.recordingFailureRequested &&
    !options.quotaExhausted &&
    !options.reservePauseRequested &&
    !options.accountRotationRequested;
}

export function recordingFailureOutcome(
  attempt: number,
  reason: string,
  nowMs = Date.now(),
): { phase: "waiting_retry"; retryAt: string; reason: string } {
  return {
    phase: "waiting_retry",
    retryAt: new Date(nowMs + retryDelayMs(attempt)).toISOString(),
    reason,
  };
}

export function outcomeAfterCleanup(
  phase: RunPhase,
  retryAt: string | null,
  reason: string | null,
  failures: readonly string[],
): { phase: RunPhase; retryAt: string | null; reason: string | null } {
  if (failures.length === 0) return { phase, retryAt, reason };
  const cleanupReason = `Cleanup incomplete: ${failures.join("; ")}`;
  return {
    phase: phase === "completed" ? "failed" : phase,
    retryAt: phase === "completed" ? null : retryAt,
    reason: reason ? `${reason}; ${cleanupReason}` : cleanupReason,
  };
}

export function currentCredentialStatus(
  credential: CodexCredentialState | null | undefined,
  accountPool: { activeAccountId: string | null; accounts: Array<{ id: string; email: string }> } | null,
): CodexCredentialState {
  const current = credential ?? CHATGPT_POOL_CREDENTIAL;
  if (current.mode === "api-key") return { ...current };
  const active = accountPool?.accounts.find(
    (account) => account.id === accountPool.activeAccountId,
  );
  return {
    ...current,
    label: active?.email ?? current.label,
  };
}

export function codexArguments(options: {
  mcpEntry: string;
  arenaUrl: string;
  controlToken: string;
  reasoningEffort: string;
  model?: string;
  modelProvider?: string;
  webSearchEnabled?: boolean;
  browserUseEnabled?: boolean;
  prompt?: string;
  resumeThreadId?: string;
}): string[] {
  const config = (key: string, value: string) => ["-c", `${key}=${value}`];
  const webSearchEnabled = options.webSearchEnabled === true;
  const browserUseEnabled = options.browserUseEnabled === true;
  const common = [
    "exec",
    "--json",
    "--model",
    options.model ?? "gpt-6-astra",
    "--color",
    "never",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    ...config("approval_policy", '"never"'),
    ...config("web_search", webSearchEnabled ? '"live"' : '"disabled"'),
    ...config("tools.web_search", webSearchEnabled ? "true" : "false"),
    ...config("features.browser_use", browserUseEnabled ? "true" : "false"),
    ...config("features.browser_use_external", browserUseEnabled ? "true" : "false"),
    ...config("features.in_app_browser", browserUseEnabled ? "true" : "false"),
    ...config("model_reasoning_effort", `"${options.reasoningEffort}"`),
    ...(options.modelProvider
      ? config("model_provider", JSON.stringify(options.modelProvider))
      : []),
    ...config("mcp_servers.game.command", '"node"'),
    ...config("mcp_servers.game.args", JSON.stringify([options.mcpEntry])),
    ...config(
      "mcp_servers.game.env",
      `{ARENA_URL=${JSON.stringify(options.arenaUrl)},ARENA_CONTROL_TOKEN=${JSON.stringify(options.controlToken)}}`,
    ),
    ...config("mcp_servers.game.required", "true"),
    ...config("mcp_servers.game.default_tools_approval_mode", '"approve"'),
    ...config(
      "mcp_servers.game.enabled_tools",
      JSON.stringify([
        "observe_screen",
        "press_keys",
        "type_text",
        "mouse",
        "challenge_time",
        "challenge_tokens",
        "complete_challenge",
      ]),
    ),
  ];
  return options.resumeThreadId
    ? [
        ...common,
        "resume",
        options.resumeThreadId,
        options.prompt ?? RESUME_PROMPT,
      ]
    : [...common, options.prompt ?? initialPrompt(DEFAULT_GOAL, "Patrick's Parabox")];
}

export async function hasHistoricalUnsupportedChatGptModel(
  runDirectory: string,
  model: string,
): Promise<boolean> {
  const filenames = [path.join(runDirectory, "codex-exec.jsonl")];
  try {
    const entries = await readdir(runDirectory);
    filenames.push(
      ...entries
        .filter((entry) => /^codex-stderr-part-\d+\.log$/.test(entry))
        .map((entry) => path.join(runDirectory, entry)),
    );
  } catch {
    // A missing run directory has no persisted diagnostic.
  }
  for (const filename of filenames) {
    try {
      if (isHistoricalUnsupportedChatGptModel(await readFile(filename, "utf8"), model)) {
        return true;
      }
    } catch {
      // Missing or unreadable diagnostics do not force a credential change.
    }
  }
  return false;
}

interface PromptPolicy {
  webSearchEnabled?: boolean;
  browserUseEnabled?: boolean;
  toolCreationGuidance?: boolean;
}

export function initialPrompt(
  goal: string,
  gameName: string,
  policy: PromptPolicy = {},
): string {
  const instructions = [
    `Goal: ${goal}`,
    `You control ${gameName} through the game MCP tools. Observe only rendered pixels and interact only through the isolated keyboard and mouse tools.`,
    capabilityInstruction(policy),
    "Work autonomously and optimize for elapsed time and token use.",
    "You decide whether the goal is complete. Call complete_challenge with a concise evidence summary only after visually verifying full completion; otherwise keep working.",
  ];
  if (policy.toolCreationGuidance) instructions.splice(3, 0, toolCreationInstruction());
  return instructions.join("\n");
}

export function continuationPrompt(
  goal: string,
  policy: PromptPolicy = {},
): string {
  const instructions = [
    `Continue the same conversation with this current goal: ${goal}`,
    "Continue from the current game state. Use only the private game computer tools for game observation and input.",
    capabilityInstruction(policy),
    "Work autonomously and optimize for elapsed time and token use.",
    "Call complete_challenge only after visually verifying the current goal is fully achieved.",
  ];
  if (policy.toolCreationGuidance) instructions.splice(3, 0, toolCreationInstruction());
  return instructions.join("\n");
}

function capabilityInstruction(policy: PromptPolicy): string {
  const search = policy.webSearchEnabled
    ? "Web search is enabled."
    : "Do not use web search.";
  const browser = policy.browserUseEnabled
    ? "Internet Browser Use is enabled."
    : "Do not use an internet browser.";
  return `${search} ${browser}`;
}

function toolCreationInstruction(): string {
  return "You may create and use local scripts and auxiliary tools, including skills and sub-agents, whenever doing so reduces elapsed time or token usage. Keep all game observation and input inside the private game-computer boundary.";
}

function normalizeGoal(value: string): string {
  const goal = value.trim();
  if (goal.length < 3 || goal.length > 4_000) {
    throw new Error("Goal must contain 3 to 4000 characters");
  }
  return goal;
}

function normalizeModel(value: string): string {
  const model = value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,80}$/i.test(model)) {
    throw new Error("Invalid model name");
  }
  return model;
}

export async function verifyCodexThreadAvailable(
  threadId: string,
  codexHome: string,
  timeoutMs = 5_000,
): Promise<void> {
  const sessionsRoot = path.join(codexHome, "sessions");
  const deadline = Date.now() + timeoutMs;
  do {
    if (await findRollout(sessionsRoot, threadId)) return;
    if (Date.now() >= deadline) break;
    await delay(100);
  } while (true);
  throw new Error(
    `Codex thread ${threadId} is missing from the shared session store ${sessionsRoot}`,
  );
}

export async function ensureCodexThreadInBase(
  threadId: string,
  baseCodexHome: string,
  accountProfiles: Array<{ home: string }>,
): Promise<void> {
  const base = await codexThreadCopy(baseCodexHome, threadId);
  const profileCopies = (await Promise.all(
    accountProfiles.map(async (profile) => ({
      profile,
      copy: path.resolve(profile.home) === path.resolve(baseCodexHome)
        ? null
        : await codexThreadCopy(profile.home, threadId),
    })),
  ))
    .filter((entry): entry is typeof entry & { copy: NonNullable<typeof entry.copy> } =>
      entry.copy !== null
    )
    .sort((left, right) => right.copy.mtimeMs - left.copy.mtimeMs);
  const newestProfile = profileCopies[0];
  if (base && (!newestProfile || base.mtimeMs >= newestProfile.copy.mtimeMs)) return;
  if (newestProfile) {
    const result = await runCommand(CODEX_COMMAND, ["--version"], {
      env: codexEnvironment(baseCodexHome, newestProfile.profile.home),
      timeoutMs: 30_000,
    });
    if (
      result.code === 0 &&
      await codexThreadCopy(baseCodexHome, threadId)
    ) {
      return;
    }
  }
  await verifyCodexThreadAvailable(threadId, baseCodexHome);
}

async function codexThreadCopy(
  codexHome: string,
  threadId: string,
): Promise<{ filename: string; mtimeMs: number } | null> {
  const filename = await findRollout(path.join(codexHome, "sessions"), threadId);
  if (!filename) return null;
  const indexed = await codexThreadIndexed(codexHome, threadId);
  if (indexed === false) return null;
  try {
    return { filename, mtimeMs: (await stat(filename)).mtimeMs };
  } catch {
    return null;
  }
}

async function codexThreadIndexed(
  codexHome: string,
  threadId: string,
): Promise<boolean | null> {
  const escaped = threadId.replaceAll("'", "''");
  try {
    const result = await runCommand(
      "sqlite3",
      [
        path.join(codexHome, "state_5.sqlite"),
        `SELECT 1 FROM threads WHERE id='${escaped}' LIMIT 1;`,
      ],
      { timeoutMs: 5_000 },
    );
    return result.code === 0 ? result.stdout.toString("utf8").trim() === "1" : null;
  } catch {
    return null;
  }
}

async function findRollout(directory: string, threadId: string): Promise<string | null> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith(".jsonl")) {
      return path.join(directory, entry.name);
    }
    if (entry.isDirectory()) {
      const nested = await findRollout(path.join(directory, entry.name), threadId);
      if (nested) return nested;
    }
  }
  return null;
}

function gameTitlePattern(game: InstalledSteamGame): RegExp {
  const terms = [game.name, path.basename(game.executable, path.extname(game.executable)), `steam_app_${game.appId}`]
    .filter((value) => value.length >= 3)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(terms.join("|"), "i");
}

function redactControlToken(args: string[]): string[] {
  return args.map((argument) =>
    argument.includes("ARENA_CONTROL_TOKEN")
      ? argument.replace(/ARENA_CONTROL_TOKEN="[^"]+"/, 'ARENA_CONTROL_TOKEN="<redacted>"')
      : argument,
  );
}

async function waitForGame(
  game: X11GameAdapter,
  timeoutMs = 120_000,
  cancelled: () => boolean = () => false,
): Promise<{ windowId: number; title: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (cancelled()) throw new Error("Interrupted while waiting for game window");
    try {
      return await game.discover();
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Game window timeout");
}

async function readBestProgress(
  directory: string,
): Promise<{ text: string; progress: LevelProgress } | null> {
  let best: { text: string; progress: LevelProgress } | null = null;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return null;
  }
  for (const name of names.filter((item) => /^save\d+\.txt$/i.test(item))) {
    try {
      const text = await readFile(path.join(directory, name), "utf8");
      const progress = parseParaboxSave(text);
      if (!best || progress.completed > best.progress.completed) {
        best = { text, progress };
      }
    } catch {
      // Save writes are not atomic; retry on the next poll.
    }
  }
  return best;
}

async function persistAttemptCheckpoint(
  checkpoint: CheckpointStore,
  state: ChallengeState,
  saveGuard: SaveGuard | null,
): Promise<void> {
  const snapshot = state.snapshot();
  await checkpoint.update({
    elapsedMs: snapshot.time.elapsedMs,
    startedAt: snapshot.time.startedAt,
    tokens: snapshot.tokens,
    tokenCursor: state.providerTokenCursorSnapshot(),
    progress: snapshot.progress,
  });
  if (saveGuard) await saveGuard.checkpointChallenge();
}

async function captureRuntimeSnapshot(
  runDirectory: string,
  attempt: number,
  game: X11GameAdapter,
  audit: AuditLog,
): Promise<GameFrame | null> {
  const directory = path.join(runDirectory, "snapshots");
  const filename = path.join(
    directory,
    `attempt-${String(attempt).padStart(4, "0")}.jpg`,
  );
  try {
    await mkdir(directory, { recursive: true });
    const frame = await game.capture();
    await writeFile(filename, frame.data);
    await audit.append("runtime.snapshot.created", {
      attempt,
      filename: path.relative(runDirectory, filename),
      sha256: frame.sha256,
      capturedAt: frame.capturedAt,
    });
    return frame;
  } catch (error) {
    await audit.append("runtime.snapshot.warning", {
      attempt,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function loadRuntimeSnapshot(
  runDirectory: string,
  attempt: number,
): Promise<GameFrame | null> {
  for (let candidate = attempt; candidate >= 1; candidate -= 1) {
    const filename = path.join(
      runDirectory,
      "snapshots",
      `attempt-${String(candidate).padStart(4, "0")}.jpg`,
    );
    try {
      const [data, metadata] = await Promise.all([readFile(filename), stat(filename)]);
      return {
        data,
        mimeType: "image/jpeg",
        width: 1920,
        height: 1080,
        sha256: createHash("sha256").update(data).digest("hex"),
        capturedAt: metadata.mtime.toISOString(),
      };
    } catch {
      // Older attempts may predate durable frame snapshots.
    }
  }
  return null;
}

async function waitUntil(
  deadlineMs: number,
  cancelled: () => boolean,
): Promise<void> {
  while (!cancelled() && Date.now() < deadlineMs) {
    await delay(Math.min(1_000, Math.max(1, deadlineMs - Date.now())));
  }
}

async function waitForPower(cancelled: () => boolean): Promise<void> {
  while (!cancelled()) {
    if (powerAllowsResume(await readPowerState())) return;
    await delay(1_000);
  }
}

export function isQuotaError(text: string): boolean {
  return /(?:\b429\b|rate[_ -]?limit|usage limit|too many requests|insufficient_quota|limit has been reached|you(?:'ve| have) hit (?:your )?[^\n]*limit)/i.test(
    text,
  );
}

export function extractQuotaResetAtFromText(
  text: string,
  nowMs = Date.now(),
): number | null {
  const dated = text.match(
    /try again at\s+([A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?,\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))/i,
  );
  if (dated) {
    const parsed = Date.parse(dated[1]!.replace(/(\d)(?:st|nd|rd|th),/i, "$1,"));
    return Number.isFinite(parsed) ? parsed : null;
  }

  const clock = text.match(
    /try again at\s+(\d{1,2}):(\d{2})\s*(AM|PM)\b/i,
  );
  if (!clock) return null;
  let hours = Number(clock[1]) % 12;
  if (clock[3]!.toUpperCase() === "PM") hours += 12;
  const reset = new Date(nowMs);
  reset.setHours(hours, Number(clock[2]), 0, 0);
  if (reset.getTime() <= nowMs) reset.setDate(reset.getDate() + 1);
  return reset.getTime();
}

export function quotaRetryAt(
  nowMs: number,
  fallbackWaitMs: number,
  reportedResetAtMs: number | null,
): string {
  const retryMs =
    reportedResetAtMs !== null && reportedResetAtMs > nowMs
      ? reportedResetAtMs + QUOTA_RESET_GRACE_MS
      : nowMs + fallbackWaitMs;
  return new Date(retryMs).toISOString();
}

function retryDelayMs(attempt: number): number {
  return Math.min(30 * 60_000, 60_000 * 2 ** Math.min(8, attempt - 1));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startHoldingOverlay(
  runtimeDirectory: string,
  display: string,
  frame: GameFrame,
): Promise<ChildProcess> {
  const framePath = path.join(runtimeDirectory, "holding-frame.jpg");
  await writeFile(framePath, frame.data);
  const environment: NodeJS.ProcessEnv = { ...process.env, DISPLAY: display };
  delete environment.WAYLAND_DISPLAY;
  delete environment.NIRI_SOCKET;
  const overlay = spawn("ffplay", [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-f", "image2", "-loop", "1",
    "-x", "1920", "-y", "1080",
    "-noborder", framePath,
  ], {
    env: environment,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  await delay(250);
  return overlay;
}

function signalProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The Codex process has already exited.
    }
  }
}
