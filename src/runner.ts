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
import { ChallengeState } from "./challenge-state.js";
import {
  CODEX_COMMAND,
  codexEnvironment,
  displayCodexHome,
  resolveCodexHome,
} from "./codex-home.js";
import {
  emptyTokenUsage,
  extractQuotaResetAt,
  extractTokenUsage,
  publicTranscriptEvent,
} from "./codex-events.js";
import { runCommand } from "./command.js";
import { ArenaController } from "./controller.js";
import { defaultGamePaths } from "./doctor.js";
import { X11GameAdapter } from "./game-adapter.js";
import {
  hiddenRecorderArguments,
  startVirtualDashboard,
  startVirtualGame,
  startVirtualGameMirror,
  type VirtualDashboardRuntime,
  type VirtualGameRuntime,
  type VirtualGameMirrorRuntime,
} from "./headless-display.js";
import { RolloutTailer } from "./rollout-tailer.js";
import { assembleRecordings, type RecordingAssembly } from "./recording-assembly.js";
import {
  CheckpointStore,
  checkpointPath,
  clearActiveRun,
  processMatches,
  processStartTicks,
  registerActiveRun,
  type RunCheckpoint,
  type RunPhase,
} from "./run-checkpoint.js";
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

export const NEUTRAL_PROMPT =
  "Complete all 364 official levels in Patrick's Parabox. Use the Parabox tools for game observation and control. Do not search or browse the internet.";
export const RESUME_PROMPT =
  "Continue the same task from the current game state. Do not search or browse the internet.";

const DEFAULT_QUOTA_WAIT_MS = 5 * 60 * 60 * 1_000;
const QUOTA_RESET_GRACE_MS = 60_000;

export interface RunOptions {
  rootDirectory: string;
  port?: number;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  record?: boolean;
  openDashboard?: boolean;
  isolateSaves?: boolean;
  output?: string;
  codexHome?: string;
  quotaWaitMs?: number;
}

export interface RunOutcome {
  runDirectory: string;
  phase: RunPhase;
  retryAt: string | null;
  reason: string | null;
}

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
  const now = new Date().toISOString();
  const persistedOptions: RunCheckpoint["options"] = {
    rootDirectory,
    port: options.port ?? 4317,
    reasoningEffort: options.reasoningEffort ?? "high",
    record: options.record !== false,
    openDashboard: options.openDashboard === true,
    isolateSaves: options.isolateSaves !== false,
    quotaWaitMs: options.quotaWaitMs ?? DEFAULT_QUOTA_WAIT_MS,
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
    options: persistedOptions,
  };
  const audit = new AuditLog(runDirectory);
  const runConfig = {
    runId,
    createdAt: now,
    model: "gpt-6-astra",
    reasoningEffort: persistedOptions.reasoningEffort,
    prompt: NEUTRAL_PROMPT,
    resumePrompt: RESUME_PROMPT,
    targetLevels: TARGET_LEVELS,
    observationPolicy: "pixels-only",
    actionPolicy: "keyboard-only",
    webSearch: "disabled",
    networkBrowser: "disabled",
    shellNetwork: "disabled",
    standardCodexCapabilities: true,
    codexLauncher: CODEX_COMMAND,
    codexHome: displayCodexHome(codexHome),
    saveIsolation: persistedOptions.isolateSaves,
    recording: persistedOptions.record,
    displayBackend: "gamescope-headless",
    recordingBackend: "gamescope-snapshot-mirror+ffmpeg-x11grab",
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
      supervisor: "astra-parabox-watchdog.service",
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

  const paths = defaultGamePaths();
  const audit = new AuditLog(runDirectory);
  const state = new ChallengeState("gpt-6-astra", TARGET_LEVELS, attempt);
  const isColdResume = prior.attempt > 0;
  const saveGuard = new SaveGuard(paths.saveDirectory, runDirectory);
  const codexHome = prior.options.codexHome;
  const sessionsRoot = path.join(
    codexHome ?? path.join(os.homedir(), ".codex"),
    "sessions",
  );
  await checkpointStore.update({
    phase: "starting",
    attempt,
    pid: process.pid,
    pidStartTicks: processStartTicks(),
    retryAt: null,
    reason: null,
  });
  await audit.append("attempt.started", { attempt, resumed: attempt > 1 });

  let codex: ChildProcess | null = null;
  let recorder: ChildProcess | null = null;
  let browser: ChildProcess | null = null;
  let game: X11GameAdapter | null = null;
  let controller: ArenaController | null = null;
  let virtualGame: VirtualGameRuntime | null = null;
  let virtualDashboard: VirtualDashboardRuntime | null = null;
  let virtualGameMirror: VirtualGameMirrorRuntime | null = null;
  let gameWindow: { windowId: number; title: string } | null = null;
  const tailers = new Set<RolloutTailer>();
  const tailerTasks = new Set<Promise<void>>();
  const eventTasks = new Set<Promise<void>>();
  let savePoll: NodeJS.Timeout | null = null;
  let checkpointPoll: NodeJS.Timeout | null = null;
  let powerPoll: NodeJS.Timeout | null = null;
  const checkpointWork: { current: Promise<void> | null } = { current: null };
  let checkpointBusy = false;
  let restored = false;
  let quotaExhausted = false;
  let quotaResetAtMs: number | null = null;
  let exitDescription = "Codex exited before completion";
  let requestedStop: "pause" | "restart" | null = null;
  let powerPauseRequested = false;
  let lastPowerState: PowerState | null = null;
  let powerPauseReason = "Low battery; snapshot saved until wake or external power";
  let powerCheckBusy = false;
  let outcomePhase: RunPhase = "waiting_retry";
  let retryAt: string | null = null;
  let reason: string | null = null;
  let productionVideo: RecordingAssembly | null = null;

  const stopRecording = async () => {
    const activeRecorder = recorder;
    recorder = null;
    if (activeRecorder?.exitCode === null) {
      activeRecorder.kill("SIGINT");
      await Promise.race([once(activeRecorder, "exit"), delay(5_000)]).catch(
        () => undefined,
      );
    }
  };

  const startRecording = async (currentAttempt: number) => {
    if (!prior.options.record || !virtualGameMirror || !virtualDashboard) {
      return;
    }
    const currentPart = String(currentAttempt).padStart(4, "0");
    const recordingRelative = path.join(
      "recordings",
      `challenge-part-${currentPart}.mkv`,
    );
    const recordingPath = path.join(runDirectory, recordingRelative);
    const captureStartedAt = new Date().toISOString();
    recorder = spawn(
      "ffmpeg",
      hiddenRecorderArguments({
        gameDisplay: virtualGameMirror.display,
        dashboardDisplay: virtualDashboard.display,
        output: recordingPath,
      }),
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    recorder.stderr?.on("data", (chunk: Buffer) => {
      void audit.appendRaw(
        `recorder-part-${currentPart}.log`,
        chunk.toString("utf8"),
      );
    });
    await delay(1_000);
    if (recorder.exitCode !== null) throw new Error("FFmpeg recorder exited early");
    await checkpointStore.update((current) => ({
      recordings: current.recordings.includes(recordingRelative)
        ? current.recordings
        : [...current.recordings, recordingRelative],
    }));
    await audit.append("recording.started", {
      attempt: currentAttempt,
      backend: "gamescope-snapshot-mirror+xvfb-x11grab",
      dimensions: "1920x1080",
      framesPerSecond: 30,
      timestampMode: "frame-count",
      captureStartedAt,
      filename: recordingRelative,
    });
  };

  const inspectDiagnostic = (text: string) => {
    if (isQuotaError(text)) quotaExhausted = true;
  };
  const inspectEvent = (event: unknown) => {
    const resetAt = extractQuotaResetAt(event);
    if (resetAt !== null && resetAt > Date.now()) {
      quotaResetAtMs = Math.max(quotaResetAtMs ?? 0, resetAt);
    }
  };
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
    controller?.cancelPendingActions();
    stopCodex();
  };
  const onTerminate = () => {
    requestedStop = "restart";
    controller?.cancelPendingActions();
    stopCodex();
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

  try {
    const steamStatus = await runCommand("pgrep", ["-x", "steam"]);
    if (steamStatus.code === 0) {
      throw new Error(
        "Steam is already running. Close it before a headless challenge so it cannot forward the game to the physical desktop.",
      );
    }
    if (prior.options.isolateSaves) {
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
      executable: paths.executable,
    });
    const activeGame = new X11GameAdapter({
      display: virtualGame.display,
      frameDirectory,
      keypressCommand: virtualGame.keypressCommand,
      compositorScreenshot: virtualGame.compositorScreenshot,
    });
    game = activeGame;
    gameWindow = await waitForGame(
      activeGame,
      120_000,
      () => requestedStop !== null,
    );
    await audit.append("game.ready", {
      ...gameWindow,
      backend: "gamescope-headless",
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
    }

    const activeController = new ArenaController({
      state,
      game: activeGame,
      ...(resumeFrame ? { initialFrame: resumeFrame } : {}),
      port: prior.options.port,
      webRoot: path.join(rootDirectory, "web"),
    });
    controller = activeController;
    const url = await activeController.listen();
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

    if (prior.options.record) {
      virtualGameMirror = await startVirtualGameMirror({
        rootDirectory,
        runtimeDirectory,
        url,
      });
      virtualDashboard = await startVirtualDashboard({
        rootDirectory,
        runtimeDirectory,
        url,
      });
    }

    if (isColdResume) {
      await startRecording(attempt);
      await delay(2_000);
      await activeGame.press(["ENTER"], { intervalMs: 0, settleMs: 1_800 });
      const restoredFrame = await activeGame.capture();
      activeController.publishFrame(restoredFrame);
      state.resume(attempt);
      await audit.append("runtime.snapshot.restored", {
        attempt,
        method: "durable-save-and-codex-thread",
        threadId: prior.threadId,
        holdingFrame: resumeFrame !== null,
        titleVisibleInRecording: false,
      });
    } else {
      state.start(prior.runId, Date.now(), process.hrtime.bigint(), {
        elapsedMs: prior.elapsedMs,
        startedAt: prior.startedAt,
        tokens: prior.tokens,
        providerTokenCursor: prior.tokenCursor ?? prior.tokens,
        progress: prior.progress,
      });
      await startRecording(attempt);
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
      snapshot: state.snapshot(),
    });
    const liveProgress = await readBestProgress(paths.saveDirectory);
    if (liveProgress) state.ingestSave(liveProgress.text);
    if (state.snapshot().status !== "completed") {
      savePoll = setInterval(() => {
        void readBestProgress(paths.saveDirectory).then((progress) => {
          if (!progress) return;
          state.ingestSave(progress.text);
        });
      }, 350);
      checkpointPoll = setInterval(() => {
        if (checkpointBusy) return;
        checkpointBusy = true;
        checkpointWork.current = persistAttemptCheckpoint(
          checkpointStore,
          state,
          prior.options.isolateSaves ? saveGuard : null,
        )
          .catch((error: unknown) => {
            void audit.append("checkpoint.warning", String(error));
          })
          .finally(() => {
            checkpointBusy = false;
          });
      }, 5_000);
      await checkPower();
      powerPoll = setInterval(() => {
        void checkPower().catch((error: unknown) => {
          void audit.append("power.warning", String(error));
        });
      }, 5_000);

      while (state.snapshot().status !== "completed" && requestedStop === null) {
        quotaExhausted = false;
        quotaResetAtMs = null;
        exitDescription = "Codex exited before completion";
        if (!powerPauseRequested) {
          const part = String(attempt).padStart(4, "0");
          const currentThreadId = checkpointStore.snapshot().threadId;
          const args = codexArguments({
            mcpEntry,
            arenaUrl: url,
            controlToken: activeController.controlToken,
            reasoningEffort: prior.options.reasoningEffort,
            ...(currentThreadId ? { resumeThreadId: currentThreadId } : {}),
          });
          const codexStartedAtMs = Date.now();
          await writeFile(
            path.join(runDirectory, `codex-command-part-${part}.json`),
            `${JSON.stringify({ command: CODEX_COMMAND, args: redactControlToken(args) }, null, 2)}\n`,
          );
          codex = spawn(CODEX_COMMAND, args, {
            cwd: workDirectory,
            env: codexEnvironment(codexHome),
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
              inspectEvent(event);
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
                  sessionsRoot,
                  codexStartedAtMs,
                );
                tailers.add(tailer);
                const tailerTask = tailer.follow(async (rolloutEvent, raw) => {
                  inspectEvent(rolloutEvent);
                  state.ingestCodexEvent(rolloutEvent);
                  if (extractTokenUsage(rolloutEvent)) {
                    await audit.appendRaw("codex-usage.jsonl", raw);
                  }
                });
                tailerTasks.add(tailerTask);
                void tailerTask
                  .catch(() => undefined)
                  .finally(() => tailerTasks.delete(tailerTask));
              }
            })();
            eventTasks.add(task);
            void task
              .catch(() => undefined)
              .finally(() => eventTasks.delete(task));
          });

          const exitPromise = once(activeCodex, "exit").then(([code, signal]) => ({
            code: typeof code === "number" ? code : null,
            signal: typeof signal === "string" ? signal : null,
          }));
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
          if (first.type === "exit" && state.snapshot().status === "running") {
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
          codex = null;
        }
        if (state.snapshot().status !== "completed") state.pause();
        await stopRecording();

        if (state.snapshot().status === "completed") break;
        const runtimeFrame = await captureRuntimeSnapshot(
          runDirectory,
          attempt,
          activeGame,
          audit,
        );
        if (runtimeFrame) activeController.publishFrame(runtimeFrame);
        await persistAttemptCheckpoint(
          checkpointStore,
          state,
          prior.options.isolateSaves ? saveGuard : null,
        );

        if (requestedStop !== null) break;
        outcomePhase = powerPauseRequested
          ? "waiting_power"
          : quotaExhausted
            ? "waiting_quota"
            : "waiting_retry";
        retryAt = powerPauseRequested
          ? null
          : quotaExhausted
            ? quotaRetryAt(Date.now(), prior.options.quotaWaitMs, quotaResetAtMs)
            : new Date(Date.now() + retryDelayMs(attempt)).toISOString();
        reason = powerPauseRequested ? powerPauseReason : exitDescription;
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
          snapshot: waitingSnapshot,
        });
        if (prior.options.record) {
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
          await waitUntil(
            Date.parse(retryAt),
            () => requestedStop !== null || powerPauseRequested,
          );
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
        attempt += 1;
        await startRecording(attempt);
        state.resume(attempt);
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
      reason = "Interrupted by shutdown or service restart";
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
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    for (const tailer of tailers) tailer.stop();
    await Promise.allSettled([...tailerTasks]);
    if (savePoll) clearInterval(savePoll);
    if (checkpointPoll) clearInterval(checkpointPoll);
    if (powerPoll) clearInterval(powerPoll);
    if (checkpointWork.current) {
      await checkpointWork.current.catch(() => undefined);
    }
    if (codex?.exitCode === null) codex.kill("SIGINT");
    await stopRecording();
    await game?.close().catch(() => undefined);
    await delay(500);
    browser?.kill("SIGTERM");
    await virtualGameMirror?.close().catch(() => undefined);
    await virtualDashboard?.close().catch(() => undefined);
    await virtualGame?.close().catch(() => undefined);
    await controller?.close().catch(() => undefined);
    if (prior.options.isolateSaves) {
      await saveGuard.checkpointChallenge().catch(async (error: unknown) => {
        await audit.append("checkpoint.save.warning", String(error));
      });
    }
    const snapshot = state.snapshot();
    const attemptStarted = snapshot.status !== "idle";
    const checkpointPhase =
      outcomePhase === "completed" && prior.options.isolateSaves
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
      snapshot,
    });
    if (outcomePhase === "completed" && prior.options.isolateSaves) {
      await saveGuard.restore();
      restored = true;
    }
    if (outcomePhase === "completed") {
      await checkpointStore.update({
        phase: "completed",
        pid: null,
        pidStartTicks: null,
      });
      if (prior.options.record) {
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

export function codexArguments(options: {
  mcpEntry: string;
  arenaUrl: string;
  controlToken: string;
  reasoningEffort: string;
  prompt?: string;
  resumeThreadId?: string;
}): string[] {
  const config = (key: string, value: string) => ["-c", `${key}=${value}`];
  const common = [
    "exec",
    "--json",
    "--model",
    "gpt-6-astra",
    "--color",
    "never",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    ...config("approval_policy", '"never"'),
    ...config("sandbox_workspace_write.network_access", "false"),
    ...config("web_search", '"disabled"'),
    ...config("tools.web_search", "false"),
    ...config("features.browser_use", "false"),
    ...config("features.browser_use_external", "false"),
    ...config("features.in_app_browser", "false"),
    ...config("model_reasoning_effort", `"${options.reasoningEffort}"`),
    ...config("mcp_servers.parabox.command", '"node"'),
    ...config("mcp_servers.parabox.args", JSON.stringify([options.mcpEntry])),
    ...config(
      "mcp_servers.parabox.env",
      `{ARENA_URL=${JSON.stringify(options.arenaUrl)},ARENA_CONTROL_TOKEN=${JSON.stringify(options.controlToken)}}`,
    ),
    ...config("mcp_servers.parabox.required", "true"),
    ...config("mcp_servers.parabox.default_tools_approval_mode", '"approve"'),
    ...config(
      "mcp_servers.parabox.enabled_tools",
      JSON.stringify([
        "observe_game",
        "press_keys",
        "challenge_time",
        "challenge_tokens",
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
    : [...common, options.prompt ?? NEUTRAL_PROMPT];
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
        width: 1280,
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
