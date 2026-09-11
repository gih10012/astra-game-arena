import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assembleRecordings,
  recordingCuts,
  recordingTimingReconciliation,
  sealedRecordingNames,
} from "../src/recording-assembly.js";
import { expectCommand } from "../src/command.js";
import type { RunCheckpoint, RunPhase } from "../src/run-checkpoint.js";

function checkpoint(phase: RunPhase, runDirectory = "/tmp/run"): RunCheckpoint {
  const now = new Date().toISOString();
  return {
    version: 1,
    runId: "run",
    runDirectory,
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
      gpuPreference: "auto",
      reasoningEffort: "high",
      record: true,
      virtualCamera: false,
      virtualCameraDevice: "/dev/video10",
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

test("requires seal evidence for paired-recorder composites", () => {
  const value = checkpoint("running");
  value.recordingPairs = [];
  assert.deepEqual(sealedRecordingNames(value), {
    names: [],
    omittedOpenRecording: null,
  });
  assert.deepEqual(sealedRecordingNames(value, [
    {
      at: new Date().toISOString(),
      type: "recording.sealed",
      data: { filename: "recordings/challenge-part-0001.mkv" },
    },
    {
      at: new Date().toISOString(),
      type: "recording.recovered",
      data: { recordings: ["recordings/challenge-part-0002.mkv"] },
    },
  ]), {
    names: [
      "recordings/challenge-part-0001.mkv",
      "recordings/challenge-part-0002.mkv",
    ],
    omittedOpenRecording: null,
  });
});

test("keeps every sealed frame when joining resumed recording parts", () => {
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
      data: {
        attempt: 2,
        activeStartedAt: "2026-01-01T01:00:03.000Z",
        activeStartedElapsedMs: 10_000,
        snapshot: snapshot(12_000),
      },
    },
    {
      at: "2026-01-01T01:00:25.180Z",
      type: "attempt.finished",
      data: {
        attempt: 2,
        activeEndedElapsedMs: 30_005,
        snapshot: snapshot(99_999),
      },
    },
  ];
  assert.deepEqual(
    recordingCuts(events, [
      "recordings/challenge-part-0001.mkv",
      "recordings/challenge-part-0002.mkv",
    ]),
    [
      { attempt: 1, trimStartSeconds: 0, activeDurationSeconds: null },
      { attempt: 2, trimStartSeconds: 0, activeDurationSeconds: null },
    ],
  );
});

test("keeps the initial title interval in the attempt-one elapsed baseline", () => {
  const events = [
    {
      at: "2026-01-01T00:00:01.000Z",
      type: "recording.started",
      data: {
        attempt: 1,
        captureStartedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    {
      at: "2026-01-01T00:00:01.100Z",
      type: "challenge.started",
      data: {
        attempt: 1,
        snapshot: { time: { elapsedMs: 1_100 } },
      },
    },
    {
      at: "2026-01-01T00:00:11.000Z",
      type: "attempt.finished",
      data: {
        attempt: 1,
        activeEndedElapsedMs: 11_000,
        snapshot: { time: { elapsedMs: 99_000 } },
      },
    },
  ];

  assert.deepEqual(
    recordingCuts(events, ["recordings/challenge-part-0001.mkv"]),
    [{ attempt: 1, trimStartSeconds: 0, activeDurationSeconds: null }],
  );
});

test("omits a sealed but invalid paired recording", async () => {
  const runDirectory = await createAssemblyRun();
  await createVideo(path.join(runDirectory, "recordings/challenge-part-0001.mkv"));
  await writeFile(
    path.join(runDirectory, "recordings/challenge-part-0002.mkv"),
    "not a video",
  );
  await writeAssemblyState(runDirectory, [
    {
      at: "2026-01-01T00:00:00.000Z",
      type: "recording.started",
      data: {
        attempt: 1,
        captureStartedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    {
      at: "2026-01-01T00:00:00.100Z",
      type: "challenge.started",
      data: { attempt: 1, snapshot: { time: { elapsedMs: 100 } } },
    },
    {
      at: "2026-01-01T00:00:20.811Z",
      type: "attempt.finished",
      data: { attempt: 1, snapshot: { time: { elapsedMs: 20_811 } } },
    },
    sealEvent(1),
    sealEvent(2),
  ]);

  const result = await assembleRecordings(runDirectory);
  assert.equal(result.sources.length, 1);
  assert.match(result.sources[0] ?? "", /challenge-part-0001\.mkv$/);
  assert.deepEqual(result.omittedParts, [{
    attempt: 2,
    filename: "recordings/challenge-part-0002.mkv",
    reason: "unplayable",
  }]);
  assert.ok(result.durationSeconds > 0);

  const persisted = checkpoint("paused", runDirectory);
  persisted.elapsedMs = 39_907;
  persisted.recordingPairs = [];
  assert.equal(recordingTimingReconciliation(persisted, result), null);
});

test("keeps a sealed resumed part instead of trimming its opening", async () => {
  const runDirectory = await createAssemblyRun();
  await Promise.all([
    createVideo(path.join(runDirectory, "recordings/challenge-part-0001.mkv")),
    createVideo(path.join(runDirectory, "recordings/challenge-part-0002.mkv")),
  ]);
  await writeAssemblyState(runDirectory, [
    {
      at: "2026-01-01T00:00:00.000Z",
      type: "challenge.started",
      data: { attempt: 1, snapshot: { time: { elapsedMs: 0 } } },
    },
    sealEvent(1),
    {
      at: "2026-01-01T00:00:00.000Z",
      type: "recording.started",
      data: {
        attempt: 2,
        captureStartedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    {
      at: "2026-01-01T00:00:01.000Z",
      type: "challenge.resumed",
      data: { attempt: 2, snapshot: { time: { elapsedMs: 20_811 } } },
    },
    {
      at: "2026-01-01T00:00:20.000Z",
      type: "attempt.finished",
      data: { attempt: 2, snapshot: { time: { elapsedMs: 39_907 } } },
    },
    sealEvent(2),
  ]);

  const result = await assembleRecordings(runDirectory);
  assert.deepEqual(result.cuts.map((cut) => cut.attempt), [1, 2]);
  assert.equal(result.activeElapsedMs, 39_907);
  assert.deepEqual(result.omittedParts, []);
  assert.equal(result.sources.length, 2);
  assert.match(result.sources[0] ?? "", /challenge-part-0001\.mkv$/);
  assert.ok(result.durationSeconds > 0);
  const audio = JSON.parse((await expectCommand("ffprobe", [
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=codec_name,sample_rate,channels",
    "-of", "json", result.output,
  ])).toString("utf8")) as {
    streams?: Array<{ codec_name?: string; sample_rate?: string; channels?: number }>;
  };
  assert.deepEqual(audio.streams?.[0], {
    codec_name: "opus", sample_rate: "48000", channels: 2,
  });

  const persisted = checkpoint("paused", runDirectory);
  persisted.elapsedMs = 39_907;
  persisted.recordingPairs = [
    { attempt: 1, game: "game-1.mkv", dashboard: "dashboard-1.mkv" },
    { attempt: 2, game: "game-2.mkv", dashboard: "dashboard-2.mkv" },
  ];
  assert.equal(recordingTimingReconciliation(persisted, result), null);
});

async function createAssemblyRun(): Promise<string> {
  const runDirectory = await mkdtemp(path.join(os.tmpdir(), "arena-assembly-"));
  await mkdir(path.join(runDirectory, "recordings"), { recursive: true });
  return runDirectory;
}

async function createVideo(filename: string): Promise<void> {
  await expectCommand("ffmpeg", [
    "-nostdin", "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=30",
    "-t", "0.5", "-c:v", "libx264", "-preset", "ultrafast",
    filename,
  ]);
}

async function writeAssemblyState(
  runDirectory: string,
  events: Array<{ at: string; type: string; data: unknown }>,
): Promise<void> {
  const value = checkpoint("paused", runDirectory);
  value.recordingPairs = [
    { attempt: 1, game: "raw/game-part-0001.mkv", dashboard: "raw/dashboard-part-0001.mkv" },
    { attempt: 2, game: "raw/game-part-0002.mkv", dashboard: "raw/dashboard-part-0002.mkv" },
  ];
  await Promise.all([
    writeFile(path.join(runDirectory, "checkpoint.json"), `${JSON.stringify(value)}\n`),
    writeFile(
      path.join(runDirectory, "events.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    ),
  ]);
}

function sealEvent(attempt: number): {
  at: string;
  type: string;
  data: { attempt: number; filename: string };
} {
  return {
    at: new Date().toISOString(),
    type: "recording.sealed",
    data: {
      attempt,
      filename: `recordings/challenge-part-${String(attempt).padStart(4, "0")}.mkv`,
    },
  };
}
