import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlPlane } from "../src/control-plane.js";
import {
  CheckpointStore,
  checkpointPath,
  durableJsonWrite,
  registerActiveRun,
  type RunCheckpoint,
} from "../src/run-checkpoint.js";

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
    "record-toggle",
    "virtual-camera-toggle",
    "virtual-camera-select",
    "model-select",
    "reasoning-select",
    "account-pool",
    "start-button",
    "pause-button",
    "resume-button",
    "end-button",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }

  const status = await fetch(`${url}/api/status`).then((response) => response.json());
  assert.equal(status.service.name, "astra-game-arena");
  assert.equal(status.challenge.phase, "idle");
  assert.equal(status.configuration.source, "defaults");
  assert.equal(status.configuration.record, true);
  assert.equal(status.configuration.virtualCamera, false);
  assert.equal(status.configuration.offlineMode, false);
  assert.equal(status.currentAccount, null);
  assert.equal(status.earliestResetAt, null);
  assert.equal(status.virtualCamera.enabled, false);
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
});
