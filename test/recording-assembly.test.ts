import assert from "node:assert/strict";
import test from "node:test";
import {
  recordingCuts,
  sealedRecordingNames,
} from "../src/recording-assembly.js";
import type { RunCheckpoint, RunPhase } from "../src/run-checkpoint.js";

function checkpoint(phase: RunPhase): RunCheckpoint {
  const now = new Date().toISOString();
  return {
    version: 1,
    runId: "run",
    runDirectory: "/tmp/run",
    createdAt: now,
    updatedAt: now,
    phase,
    attempt: 2,
    pid: null,
    pidStartTicks: null,
    threadId: null,
    retryAt: null,
    reason: null,
    savePrepared: true,
    elapsedMs: 0,
    startedAt: now,
    tokens: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
    progress: { total: 364, unlocked: 1, completed: 1 },
    recordings: [
      "recordings/challenge-part-0001.mkv",
      "recordings/challenge-part-0002.mkv",
    ],
    options: {
      rootDirectory: "/tmp",
      port: 4317,
      reasoningEffort: "high",
      record: true,
      openDashboard: false,
      isolateSaves: true,
      quotaWaitMs: 1,
    },
  };
}

test("omits only the recording that may still be open", () => {
  assert.deepEqual(sealedRecordingNames(checkpoint("running")), {
    names: ["recordings/challenge-part-0001.mkv"],
    omittedOpenRecording: "recordings/challenge-part-0002.mkv",
  });
  assert.deepEqual(sealedRecordingNames(checkpoint("waiting_quota")), {
    names: [
      "recordings/challenge-part-0001.mkv",
      "recordings/challenge-part-0002.mkv",
    ],
    omittedOpenRecording: null,
  });
  assert.deepEqual(sealedRecordingNames(checkpoint("completed")), {
    names: [
      "recordings/challenge-part-0001.mkv",
      "recordings/challenge-part-0002.mkv",
    ],
    omittedOpenRecording: null,
  });
});

test("keeps every sealed composite in the paired-recorder format", () => {
  const value = checkpoint("running");
  value.recordingPairs = [];
  assert.deepEqual(sealedRecordingNames(value), {
    names: [
      "recordings/challenge-part-0001.mkv",
      "recordings/challenge-part-0002.mkv",
    ],
    omittedOpenRecording: null,
  });
});

test("cuts resumed parts at their active snapshot boundary", () => {
  const snapshot = (elapsedMs: number) => ({ time: { elapsedMs } });
  const events = [
    {
      at: "2026-01-01T00:00:00.000Z",
      type: "recording.started",
      data: { attempt: 1 },
    },
    {
      at: "2026-01-01T00:00:01.000Z",
      type: "challenge.started",
      data: { attempt: 1, snapshot: snapshot(0) },
    },
    {
      at: "2026-01-01T00:00:11.000Z",
      type: "attempt.finished",
      data: { attempt: 1, snapshot: snapshot(10_000) },
    },
    {
      at: "2026-01-01T01:00:01.000Z",
      type: "recording.started",
      data: {
        attempt: 2,
        captureStartedAt: "2026-01-01T01:00:00.000Z",
      },
    },
    {
      at: "2026-01-01T01:00:05.175Z",
      type: "challenge.resumed",
      data: { attempt: 2, snapshot: snapshot(10_000) },
    },
    {
      at: "2026-01-01T01:00:25.180Z",
      type: "attempt.finished",
      data: { attempt: 2, snapshot: snapshot(30_005) },
    },
  ];
  assert.deepEqual(
    recordingCuts(events, [
      "recordings/challenge-part-0001.mkv",
      "recordings/challenge-part-0002.mkv",
    ]),
    [
      { attempt: 1, trimStartSeconds: 0, activeDurationSeconds: 10 },
      {
        attempt: 2,
        trimStartSeconds: 5.2,
        activeDurationSeconds: 20,
      },
    ],
  );
});
