import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CheckpointStore, clearActiveRun, readActiveRun } from "../src/run-checkpoint.js";
import { queueChallenge, resumeChallenge } from "../src/runner.js";

test("queues a new challenge without attaching it to the launching process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runner-queue-"));
  const runDirectory = path.join(root, "runs", "queued");

  try {
    const outcome = await queueChallenge({
      rootDirectory: root,
      output: runDirectory,
      record: false,
    });
    const checkpoint = (await CheckpointStore.load(runDirectory)).snapshot();

    assert.equal(outcome.phase, "waiting_retry");
    assert.equal(outcome.runDirectory, runDirectory);
    assert.equal(checkpoint.pid, null);
    assert.equal(checkpoint.pidStartTicks, null);
    assert.equal(checkpoint.attempt, 0);
    assert.equal(await readActiveRun(root), runDirectory);

    await clearActiveRun(root, runDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to cold-relaunch a game after its in-memory runtime was lost", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runner-no-cold-resume-"));
  const runDirectory = path.join(root, "runs", "lost-runtime");

  try {
    await queueChallenge({ rootDirectory: root, output: runDirectory, record: false });
    const store = await CheckpointStore.load(runDirectory);
    await store.update({
      phase: "paused",
      attempt: 1,
      pid: null,
      pidStartTicks: null,
      reason: "runner lost",
    });

    await assert.rejects(
      resumeChallenge(runDirectory),
      /automatic cold relaunch is disabled/,
    );
    assert.equal((await CheckpointStore.load(runDirectory)).snapshot().attempt, 1);
    await clearActiveRun(root, runDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
