import assert from "node:assert/strict";
import { mkdtemp, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CheckpointStore,
  checkpointPath,
  clearActiveRun,
  processMatches,
  processStartTicks,
  readActiveRun,
  registerActiveRun,
  type RunCheckpoint,
} from "../src/run-checkpoint.js";

test("durably tracks an active resumable run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "run-checkpoint-"));
  const runDirectory = path.join(root, "runs", "one");
  const now = new Date().toISOString();
  const initial: RunCheckpoint = {
    version: 1,
    runId: "one",
    runDirectory,
    createdAt: now,
    updatedAt: now,
    phase: "starting",
    attempt: 0,
    pid: null,
    pidStartTicks: null,
    threadId: null,
    retryAt: null,
    reason: null,
    savePrepared: false,
    elapsedMs: 0,
    startedAt: null,
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
      port: 4317,
      gpuPreference: "auto",
      reasoningEffort: "high",
      record: true,
      virtualCamera: false,
      virtualCameraDevice: "/dev/video10",
      openDashboard: true,
      isolateSaves: true,
      quotaWaitMs: 18_000_000,
    },
  };
  const store = new CheckpointStore(checkpointPath(runDirectory), initial);
  await store.update({ phase: "waiting_quota", attempt: 1, elapsedMs: 1234 });
  await registerActiveRun(root, runDirectory);

  assert.equal(await readActiveRun(root), runDirectory);
  const loaded = await CheckpointStore.load(runDirectory);
  assert.equal(loaded.snapshot().phase, "waiting_quota");
  assert.equal(loaded.snapshot().elapsedMs, 1234);

  const renamedRoot = `${root}-renamed`;
  await rename(root, renamedRoot);
  const relocatedRun = path.join(renamedRoot, "runs", "one");
  assert.equal(await readActiveRun(renamedRoot), relocatedRun);
  const relocated = await CheckpointStore.load(relocatedRun);
  assert.equal(relocated.snapshot().runDirectory, relocatedRun);
  assert.equal(relocated.snapshot().options.rootDirectory, renamedRoot);

  await clearActiveRun(renamedRoot, relocatedRun);
  assert.equal(await readActiveRun(renamedRoot), null);
});

test("distinguishes a live runner from a reused PID", () => {
  const ticks = processStartTicks();
  assert.ok(ticks);
  assert.equal(processMatches(process.pid, ticks), true);
  assert.equal(processMatches(process.pid, `${ticks}-different`), false);
  assert.equal(processMatches(2_147_483_647, null), false);
});
