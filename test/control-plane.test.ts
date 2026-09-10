import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlPlane } from "../src/control-plane.js";
import {
  CheckpointStore,
  checkpointPath,
  clearActiveRun,
  durableJsonWrite,
  processStartTicks,
  registerActiveRun,
  type RunCheckpoint,
} from "../src/run-checkpoint.js";
import {
  readRuntimeConfigRequest,
  writeRuntimeConfigAck,
  writeRuntimeMediaState,
} from "../src/runtime-config.js";

test("serves the durable control page with every pre-run setting", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "game-arena-control-"));
  const control = new ControlPlane(root, { port: 0 });
  const url = await control.listen();
  context.after(() => control.close());

  assert.deepEqual(await fetch(`${url}/health`).then((response) => response.json()), {
    ok: true,
    service: "astra-game-arena",
  });
  const html = await fetch(url).then((response) => response.text());
  for (const id of [
    "game-select",
    "gpu-select",
    "offline-mode-toggle",
    "goal-input",
    "web-search-toggle",
    "browser-use-toggle",
    "tool-guidance-toggle",
    "web-search-badge",
    "browser-use-badge",
    "record-toggle",
    "virtual-camera-toggle",
    "virtual-camera-select",
    "virtual-microphone-state",
    "model-select",
    "reasoning-select",
    "account-pool",
    "start-button",
    "pause-button",
    "resume-button",
    "end-button",
    "broadcast-button",
    "broadcast-configuration",
    "media-library",
    "broadcast-audio",
    "broadcast-replay",
    "live-audio",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.equal((await fetch(`${url}/control`)).status, 200);
  assert.equal((await fetch(`${url}/live`)).status, 200);
  assert.equal((await fetch(`${url}/live`, { method: "HEAD" })).status, 200);
  const broadcast = await fetch(`${url}/api/broadcast`).then((response) => response.json());
  assert.equal(broadcast.playback.mode, "standby");
  assert.equal(broadcast.configuration.mode, "auto");
  assert.equal(broadcast.liveUrl, `${url}/live`);

  const status = await fetch(`${url}/api/status`).then((response) => response.json());
  assert.equal(status.service.name, "astra-game-arena");
  assert.equal(status.challenge.phase, "idle");
  assert.equal(status.configuration.source, "defaults");
  assert.equal(status.configuration.record, true);
  assert.equal(status.configuration.virtualCamera, false);
  assert.equal(status.configuration.offlineMode, false);
  assert.equal(status.configuration.webSearchEnabled, false);
  assert.equal(status.configuration.browserUseEnabled, false);
  assert.equal(status.configuration.toolCreationGuidance, false);
  assert.equal(status.currentAccount, null);
  assert.equal(status.earliestResetAt, null);
  assert.equal(status.virtualCamera.enabled, false);
  assert.equal(status.virtualMicrophone.enabled, false);
  assert.equal(status.broadcast.configuration.mode, "auto");
  assert.equal(status.broadcast.playback.mode, "standby");
  assert.deepEqual(status.continuity, {
    mode: "retained-live-process",
    runtimeRetained: false,
    runtimeFrozen: false,
    coldRelaunchAllowed: false,
    daemonRestartSafe: true,
  });
});

test("reports active configuration, account percentages, and earliest reset", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "game-arena-status-"));
  const runDirectory = path.join(root, "runs", "status-run");
  const now = new Date().toISOString();
  const fiveHourReset = Date.now() + 60 * 60_000;
  const weeklyReset = Date.now() + 24 * 60 * 60_000;
  const checkpoint: RunCheckpoint = {
    version: 1,
    runId: "status-run",
    runDirectory,
    createdAt: now,
    updatedAt: now,
    phase: "waiting_quota",
    attempt: 2,
    pid: null,
    pidStartTicks: null,
    threadId: "thread-1",
    retryAt: new Date(fiveHourReset).toISOString(),
    reason: "quota",
    savePrepared: true,
    elapsedMs: 12_345,
    startedAt: now,
    tokens: {
      inputTokens: 100,
      cachedInputTokens: 50,
      outputTokens: 20,
      reasoningOutputTokens: 10,
      totalTokens: 120,
    },
    progress: { total: 364, unlocked: 20, completed: 10 },
    recordings: [],
    options: {
      rootDirectory: root,
      publicPort: 4317,
      port: 4318,
      model: "gpt-6-astra",
      goal: "Complete the game",
      gpuPreference: "discrete",
      offlineMode: true,
      reasoningEffort: "high",
      record: true,
      virtualCamera: true,
      virtualCameraDevice: "/dev/video10",
      openDashboard: false,
      isolateSaves: true,
      quotaWaitMs: 18_000_000,
      accountPolicies: [],
    },
  };
  await new CheckpointStore(checkpointPath(runDirectory), checkpoint).update({});
  await registerActiveRun(root, runDirectory);
  await durableJsonWrite(path.join(runDirectory, "account-pool.json"), {
    version: 1,
    activeAccountId: "account-1",
    accounts: [{
      id: "account-1",
      email: "one@example.com",
      home: "/private/one",
      reserveFiveHourPercent: 25,
      reserveWeeklyPercent: 10,
      primary: { usedPercent: 37, resetsAtMs: fiveHourReset },
      secondary: { usedPercent: 60, resetsAtMs: weeklyReset },
      blockedUntilMs: null,
      lastPrimaryResetAtMs: null,
      updatedAt: now,
    }],
  });

  const control = new ControlPlane(root, { port: 0 });
  const url = await control.listen();
  context.after(() => control.close());
  const status = await fetch(`${url}/api/status`).then((response) => response.json());

  assert.equal(status.configuration.model, "gpt-6-astra");
  assert.equal(status.configuration.gpuPreference, "discrete");
  assert.equal(status.configuration.offlineMode, true);
  assert.equal(status.configuration.source, "active-run");
  assert.equal(status.configuration.virtualCamera, true);
  assert.equal(status.currentAccount.email, "one@example.com");
  assert.equal(status.currentAccount.fiveHour.usedPercent, 37);
  assert.equal(status.currentAccount.fiveHour.remainingPercent, 63);
  assert.equal(status.currentAccount.weekly.remainingPercent, 40);
  assert.equal(status.earliestResetAt, new Date(fiveHourReset).toISOString());
  assert.equal(status.accountPool.earliestFiveHourResetAt, new Date(fiveHourReset).toISOString());
  assert.equal("home" in status.currentAccount, false);

  const goalUpdate = await fetch(`${url}/api/configuration`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal: "Replace the active goal" }),
  }).then((response) => response.json());
  assert.equal(goalUpdate.accepted, true);

  const immutableLaunch = await fetch(`${url}/api/configuration`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ launchMode: "steam-offline" }),
  });
  assert.equal(immutableLaunch.status, 409);

  const updated = await fetch(`${url}/api/configuration`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reasoningEffort: "xhigh",
      record: false,
      quotaWaitMs: 7_200_000,
      webSearchEnabled: true,
      browserUseEnabled: true,
      toolCreationGuidance: true,
    }),
  }).then((response) => response.json());
  assert.equal(updated.accepted, true);
  assert.deepEqual(updated.acknowledgement.deferredFields, []);
  const persisted = (await CheckpointStore.load(runDirectory)).snapshot();
  assert.equal(persisted.options.launchMode, undefined);
  assert.equal(persisted.options.reasoningEffort, "xhigh");
  assert.equal(persisted.options.record, false);
  assert.equal(persisted.options.goal, "Replace the active goal");
  assert.equal(persisted.options.webSearchEnabled, true);
  assert.equal(persisted.options.browserUseEnabled, true);
  assert.equal(persisted.options.toolCreationGuidance, true);

  const firstPause = await fetch(`${url}/api/control/pause`, { method: "POST" })
    .then((response) => response.json());
  assert.equal(firstPause.alreadyPaused, undefined);
  const secondPause = await fetch(`${url}/api/control/pause`, { method: "POST" })
    .then((response) => response.json());
  assert.equal(secondPause.alreadyPaused, true);

  await clearActiveRun(root, runDirectory);
  await control.refresh();
  const idleStatus = await fetch(`${url}/api/status`).then((response) => response.json());
  assert.equal(idleStatus.configuration.source, "saved");
  assert.equal(idleStatus.configuration.launchMode, "direct");
  assert.equal(idleStatus.configuration.reasoningEffort, "xhigh");
  assert.equal(idleStatus.configuration.record, false);
  assert.equal(idleStatus.configuration.goal, "Replace the active goal");
  assert.equal(idleStatus.configuration.webSearchEnabled, true);
  assert.equal(idleStatus.configuration.browserUseEnabled, true);
  assert.equal(idleStatus.configuration.toolCreationGuidance, true);
});

test("reports an API key as the current credential without OAuth percentages", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "game-arena-api-credential-"));
  const runDirectory = path.join(root, "runs", "api-credential-run");
  const checkpoint = testCheckpoint(root, runDirectory, {
    credential: {
      mode: "api-key",
      provider: "custom",
      label: "custom API key",
    },
  });
  await new CheckpointStore(checkpointPath(runDirectory), checkpoint).update({});
  await registerActiveRun(root, runDirectory);
  await durableJsonWrite(path.join(runDirectory, "account-pool.json"), {
    version: 1,
    activeAccountId: "inactive-oauth-account",
    accounts: [{
      id: "inactive-oauth-account",
      email: "inactive@example.test",
      home: "/private/oauth-account",
      reserveFiveHourPercent: 35,
      reserveWeeklyPercent: 20,
      primary: { usedPercent: 62, resetsAtMs: Date.now() + 60_000 },
      secondary: { usedPercent: 45, resetsAtMs: Date.now() + 120_000 },
      blockedUntilMs: null,
      lastPrimaryResetAtMs: null,
      updatedAt: new Date().toISOString(),
    }],
  });

  const control = new ControlPlane(root, { port: 0 });
  const url = await control.listen();
  context.after(() => control.close());

  const status = await fetch(`${url}/api/status`).then((response) => response.json());
  assert.deepEqual(status.currentCredential, {
    mode: "api-key",
    provider: "custom",
    label: "custom API key",
  });
  assert.equal(status.currentAccount, null);
  assert.equal(status.earliestResetAt, null);
  assert.equal(status.accountPool.schedulingActive, false);
  assert.equal(status.accountPool.activeAccountId, null);
  assert.equal(status.accountPool.accounts[0].reserveFiveHourPercent, 35);
  assert.equal(status.accountPool.accounts[0].fiveHour.usedPercent, 62);
  assert.equal("home" in status.currentCredential, false);

  const supervisor = await fetch(`${url}/api/supervisor`)
    .then((response) => response.json());
  assert.deepEqual(supervisor.currentCredential, status.currentCredential);

  const updated = await fetch(`${url}/api/configuration`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountPolicies: [] }),
  }).then((response) => response.json());
  assert.equal(updated.accepted, true);
  assert.deepEqual(
    (await CheckpointStore.load(runDirectory)).snapshot().credential,
    status.currentCredential,
  );
});

test("routes waiting live runners through request acknowledgements and reports actual media", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "game-arena-live-config-"));
  const runDirectory = path.join(root, "runs", "live-config-run");
  const checkpoint = testCheckpoint(root, runDirectory, {
    phase: "waiting_quota",
    pid: process.pid,
    pidStartTicks: processStartTicks(),
    gameRuntimeReady: true,
    gameRuntimeFrozen: true,
  });
  await new CheckpointStore(checkpointPath(runDirectory), checkpoint).update({});
  await writeRuntimeMediaState(runDirectory, {
    version: 1,
    updatedAt: new Date().toISOString(),
    recordingActive: true,
    recordingError: "prior recorder warning",
    virtualCameraActive: true,
    virtualCameraDevice: "/dev/video10",
    virtualCameraError: "prior camera warning",
    virtualMicrophoneActive: true,
    virtualMicrophoneName: "astra_game_microphone_test",
    virtualMicrophoneError: null,
  });
  await registerActiveRun(root, runDirectory);

  const control = new ControlPlane(root, { port: 0 });
  const url = await control.listen();
  context.after(() => control.close());

  const status = await fetch(`${url}/api/status`).then((response) => response.json());
  assert.equal(status.recording.active, true);
  assert.equal(status.recording.lastError, "prior recorder warning");
  assert.equal(status.virtualCamera.active, true);
  assert.equal(status.virtualCamera.lastError, "prior camera warning");
  assert.equal(status.virtualMicrophone.active, true);
  assert.equal(status.virtualMicrophone.name, "astra_game_microphone_test");
  assert.equal(status.continuity.runtimeRetained, true);
  assert.equal(status.continuity.runtimeFrozen, true);
  const supervisor = await fetch(`${url}/api/supervisor`).then((response) => response.json());
  assert.equal(supervisor.recording.active, true);
  assert.equal(supervisor.virtualCamera.active, true);
  assert.equal(supervisor.virtualMicrophone.active, true);

  await writeRuntimeMediaState(runDirectory, {
    version: 1,
    updatedAt: new Date().toISOString(),
    recordingActive: false,
    recordingError: null,
    virtualCameraActive: false,
    virtualCameraDevice: null,
    virtualCameraError: "camera exited",
    virtualMicrophoneActive: false,
    virtualMicrophoneName: "astra_game_microphone_test",
    virtualMicrophoneError: "microphone exited",
  });

  const pendingResponse = fetch(`${url}/api/configuration`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ record: false }),
  });
  const request = await waitForRuntimeRequest(runDirectory);
  assert.deepEqual(request.patch, { record: false });
  await (await CheckpointStore.load(runDirectory)).update((current) => ({
    options: { ...current.options, record: false },
  }));
  await writeRuntimeConfigAck(runDirectory, {
    version: 1,
    id: request.id,
    appliedAt: new Date().toISOString(),
    appliedFields: ["record"],
    deferredFields: [],
    codexRestarted: false,
    error: null,
  });
  const appliedResponse = await pendingResponse;
  const applied = await appliedResponse.json();
  assert.equal(appliedResponse.status, 200);
  assert.equal(applied.accepted, true);
  assert.equal(applied.pending, false);
  assert.equal(applied.acknowledgement.id, request.id);

  const rejectedResponsePromise = fetch(`${url}/api/configuration`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ virtualCamera: false }),
  });
  const rejectedRequest = await waitForRuntimeRequest(runDirectory);
  await writeRuntimeConfigAck(runDirectory, {
    version: 1,
    id: rejectedRequest.id,
    appliedAt: new Date().toISOString(),
    appliedFields: [],
    deferredFields: [],
    codexRestarted: false,
    error: "virtual camera stop failed",
  });
  const rejectedResponse = await rejectedResponsePromise;
  const rejected = await rejectedResponse.json();
  assert.equal(rejectedResponse.status, 409);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.pending, false);
  assert.equal(rejected.acknowledgement.error, "virtual camera stop failed");

  const timedOutResponse = await fetch(`${url}/api/configuration`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reasoningEffort: "medium" }),
  });
  const timedOut = await timedOutResponse.json();
  assert.equal(timedOutResponse.status, 202);
  assert.equal(timedOut.accepted, true);
  assert.equal(timedOut.pending, true);
  assert.equal(timedOut.acknowledgement, null);
  assert.equal(timedOut.configuration.reasoningEffort, "high");

  await (await CheckpointStore.load(runDirectory)).update({
    pid: null,
    pidStartTicks: null,
  });
  await control.refresh();
  const stoppedMedia = await fetch(`${url}/api/status`).then((response) => response.json());
  assert.equal(stoppedMedia.recording.active, false);
  assert.equal(stoppedMedia.virtualCamera.active, false);
  assert.equal(stoppedMedia.virtualMicrophone.active, false);

  await clearActiveRun(root, runDirectory);
  await control.refresh();
  const saved = await fetch(`${url}/api/status`).then((response) => response.json());
  assert.equal(saved.configuration.record, false);
  assert.equal(saved.configuration.virtualCamera, true);
});

test("proxies the live runner stream without requiring a virtual camera", async (context) => {
  let liveRequests = 0;
  let audioRequests = 0;
  const runner = createServer((request, response) => {
    if (request.url === "/api/live.mjpeg") {
      liveRequests += 1;
      response.writeHead(200, {
        "Content-Type": "multipart/x-mixed-replace; boundary=runner",
      });
      response.end("--runner\r\nContent-Type: image/jpeg\r\n\r\nFRAME\r\n--runner--\r\n");
      return;
    }
    if (request.url === "/api/live-audio.ogg") {
      audioRequests += 1;
      response.writeHead(200, { "Content-Type": "audio/ogg; codecs=opus" });
      response.end("OGG-AUDIO");
      return;
    }
    response.writeHead(204);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    runner.once("error", reject);
    runner.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise<void>((resolve) => runner.close(() => resolve())));
  const runnerAddress = runner.address();
  assert.ok(runnerAddress && typeof runnerAddress === "object");

  const root = await mkdtemp(path.join(os.tmpdir(), "game-arena-live-preview-"));
  const runDirectory = path.join(root, "runs", "live-preview-run");
  const checkpoint = testCheckpoint(root, runDirectory, {
    phase: "running",
    pid: process.pid,
    pidStartTicks: processStartTicks(),
    gameRuntimeReady: true,
  });
  checkpoint.options.port = runnerAddress.port;
  checkpoint.options.virtualCamera = false;
  await new CheckpointStore(checkpointPath(runDirectory), checkpoint).update({});
  await writeRuntimeMediaState(runDirectory, {
    version: 1,
    updatedAt: new Date().toISOString(),
    recordingActive: false,
    recordingError: null,
    virtualCameraActive: false,
    virtualCameraDevice: null,
    virtualCameraError: null,
  });
  await registerActiveRun(root, runDirectory);

  const control = new ControlPlane(root, { port: 0 });
  const url = await control.listen();
  context.after(() => control.close());

  const preview = await fetch(`${url}/api/live.mjpeg`);
  assert.equal(preview.status, 200);
  assert.equal(
    preview.headers.get("content-type"),
    "multipart/x-mixed-replace; boundary=runner",
  );
  assert.match(await preview.text(), /FRAME/);
  assert.equal(liveRequests, 1);
  const audio = await fetch(`${url}/api/live-audio.ogg`);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get("content-type"), "audio/ogg; codecs=opus");
  assert.equal(await audio.text(), "OGG-AUDIO");
  assert.equal(audioRequests, 1);

  await (await CheckpointStore.load(runDirectory)).update({
    pid: null,
    pidStartTicks: null,
  });
  await control.refresh();
  const unavailable = await fetch(`${url}/api/live.mjpeg`);
  assert.equal(unavailable.status, 409);
  assert.equal((await fetch(`${url}/api/live-audio.ogg`)).status, 409);
});

test("persists the OBS replay playlist through the control plane", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "game-arena-broadcast-api-"));
  const mediaDirectory = path.join(root, ".arena", "broadcast-media");
  await mkdir(mediaDirectory, { recursive: true });
  await writeFile(path.join(mediaDirectory, "one.mp4"), "video");
  const control = new ControlPlane(root, { port: 0 });
  const url = await control.listen();
  context.after(() => control.close());
  const initial = await fetch(`${url}/api/broadcast`).then((response) => response.json());
  assert.equal(initial.library.length, 1);
  const id = initial.library[0].id;
  const saved = await fetch(`${url}/api/broadcast`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "replay", playlist: [id], volume: 0.5 }),
  }).then((response) => response.json());
  assert.deepEqual(saved.configuration.playlist, [id]);
  assert.equal(saved.playback.mode, "replay");
  assert.equal(saved.configuration.volume, 0.5);
  const rejected = await fetch(`${url}/api/broadcast`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playlist: ["unknown"] }),
  });
  assert.equal(rejected.status, 400);
  const manualRoot = await mkdtemp(path.join(os.tmpdir(), "game-arena-manual-api-"));
  const manualFile = path.join(manualRoot, "manual.webm");
  await writeFile(manualFile, "manual-video");
  const imported = await fetch(`${url}/api/broadcast/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: manualFile, select: true }),
  }).then((response) => response.json());
  const manual = imported.library.find((item: { source: string }) => item.source === "manual");
  assert.ok(manual);
  const forgotten = await fetch(`${url}/api/broadcast/media?id=${manual.id}`, {
    method: "DELETE",
  }).then((response) => response.json());
  assert.equal(forgotten.library.some((item: { id: string }) => item.id === manual.id), false);
  assert.equal(forgotten.configuration.manualFileCount, 0);
  assert.equal(await readFile(manualFile, "utf8"), "manual-video");
  await fetch(`${url}/api/broadcast`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "auto" }),
  });
  const runDirectory = path.join(root, "runs", "quota-broadcast-run");
  const retryAt = new Date(Date.now() + 60_000).toISOString();
  const checkpoint = testCheckpoint(root, runDirectory, {
    phase: "waiting_quota",
    retryAt,
    reason: "Quota exhausted",
  });
  await new CheckpointStore(checkpointPath(runDirectory), checkpoint).update({});
  await registerActiveRun(root, runDirectory);
  await control.refresh();
  const quotaReplay = await fetch(`${url}/api/broadcast`).then((response) => response.json());
  assert.equal(quotaReplay.playback.mode, "replay");
  assert.equal(quotaReplay.playback.reason, "waiting_quota");
  assert.equal(quotaReplay.playback.retryAt, retryAt);
});

test("serializes concurrent checkpoint configuration updates", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "game-arena-concurrent-config-"));
  const runDirectory = path.join(root, "runs", "concurrent-config-run");
  const checkpoint = testCheckpoint(root, runDirectory);
  await new CheckpointStore(checkpointPath(runDirectory), checkpoint).update({});
  await registerActiveRun(root, runDirectory);

  const control = new ControlPlane(root, { port: 0 });
  const url = await control.listen();
  context.after(() => control.close());
  const responses = await Promise.all([
    fetch(`${url}/api/configuration`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ record: false }),
    }),
    fetch(`${url}/api/configuration`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reasoningEffort: "xhigh" }),
    }),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  const persisted = (await CheckpointStore.load(runDirectory)).snapshot();
  assert.equal(persisted.options.record, false);
  assert.equal(persisted.options.reasoningEffort, "xhigh");
});

function testCheckpoint(
  root: string,
  runDirectory: string,
  overrides: Partial<RunCheckpoint> = {},
): RunCheckpoint {
  const now = new Date().toISOString();
  return {
    version: 1,
    runId: path.basename(runDirectory),
    runDirectory,
    createdAt: now,
    updatedAt: now,
    phase: "waiting_retry",
    attempt: 1,
    pid: null,
    pidStartTicks: null,
    threadId: null,
    retryAt: now,
    reason: "test",
    savePrepared: true,
    elapsedMs: 100,
    startedAt: now,
    tokens: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
    progress: { total: 0, unlocked: 0, completed: 0 },
    recordings: [],
    options: {
      rootDirectory: root,
      publicPort: 4317,
      port: 4318,
      model: "gpt-6-astra",
      goal: "Complete the test challenge",
      gpuPreference: "auto",
      launchMode: "steam-offline",
      offlineMode: false,
      reasoningEffort: "high",
      record: true,
      virtualCamera: true,
      virtualCameraDevice: "/dev/video10",
      openDashboard: false,
      isolateSaves: true,
      quotaWaitMs: 18_000_000,
      accountPolicies: [],
    },
    ...overrides,
  };
}

async function waitForRuntimeRequest(runDirectory: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const request = await readRuntimeConfigRequest(runDirectory);
    if (request) return request;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for runtime configuration request");
}
