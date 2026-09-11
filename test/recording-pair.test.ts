import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditLog } from "../src/audit-log.js";
import { expectCommand } from "../src/command.js";
import {
  composeRecordingPair,
  discoverCompletedRecordingPairs,
  recordingPairIsActive,
  startRecordingPair,
  type ActiveRecordingPair,
} from "../src/recording-pair.js";

test("requires both recorder processes to remain active for an attempt", () => {
  const runningProcess = () => ({ exitCode: null, signalCode: null }) as ChildProcess;
  const pair: ActiveRecordingPair = {
    metadata: { attempt: 3, game: "game.mkv", dashboard: "dashboard.mkv" },
    compositeRelative: "challenge.mkv",
    captureStartedAt: "2026-01-01T00:00:00.000Z",
    captureStartedWallMs: 0,
    captureStartedMono: 0n,
    gameProcess: runningProcess(),
    dashboardProcess: runningProcess(),
    stopping: false,
  };

  assert.equal(recordingPairIsActive(pair, 3), true);
  assert.equal(recordingPairIsActive(pair, 2), false);
  pair.dashboardProcess = { exitCode: 1, signalCode: null } as ChildProcess;
  assert.equal(recordingPairIsActive(pair, 3), false);
  pair.dashboardProcess = runningProcess();
  pair.stopping = true;
  assert.equal(recordingPairIsActive(pair, 3), false);
});

test("composes native game and transcript streams into CFR 1920x1080 video", async () => {
  const runDirectory = await mkdtemp(path.join(os.tmpdir(), "game-arena-recording-"));
  const rawDirectory = path.join(runDirectory, "recordings", "raw");
  await mkdir(rawDirectory, { recursive: true });
  const game = path.join(rawDirectory, "game-part-0001.mkv");
  const dashboard = path.join(rawDirectory, "dashboard-part-0001.mkv");
  await Promise.all([
    expectCommand("ffmpeg", [
      "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "0.5", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "libopus", game,
    ]),
    expectCommand("ffmpeg", [
      "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=navy:size=1920x1080:rate=30",
      "-t", "0.5", "-c:v", "libx264", "-preset", "ultrafast", dashboard,
    ]),
  ]);
  const relative = await composeRecordingPair(runDirectory, {
    attempt: 1,
    game: path.relative(runDirectory, game),
    dashboard: path.relative(runDirectory, dashboard),
  });
  const probe = JSON.parse((await expectCommand("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate",
    "-of", "json", path.join(runDirectory, relative),
  ])).toString("utf8")) as { streams: Array<{ width: number; height: number; r_frame_rate: string }> };
  assert.deepEqual(probe.streams[0], { width: 1920, height: 1080, r_frame_rate: "30/1" });
  const audioProbe = JSON.parse((await expectCommand("ffprobe", [
    "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate,channels",
    "-of", "json", path.join(runDirectory, relative),
  ])).toString("utf8")) as { streams: Array<{ codec_name: string; sample_rate: string; channels: number }> };
  assert.deepEqual(audioProbe.streams[0], { codec_name: "opus", sample_rate: "48000", channels: 2 });
  const pair = {
    attempt: 1,
    game: path.relative(runDirectory, game),
    dashboard: path.relative(runDirectory, dashboard),
  };
  assert.deepEqual(
    await discoverCompletedRecordingPairs(runDirectory, [pair], [], 2),
    [relative],
  );
  assert.deepEqual(
    await discoverCompletedRecordingPairs(runDirectory, [pair], [], 1),
    [],
  );
});

test("reports a recorder that dies after startup", async () => {
  const runDirectory = await mkdtemp(path.join(os.tmpdir(), "game-arena-recorder-exit-"));
  const binDirectory = path.join(runDirectory, "bin");
  await mkdir(binDirectory);
  await Promise.all([
    writeFile(
      path.join(binDirectory, "wf-recorder"),
      "#!/bin/sh\nsleep 1.4\nexit 23\n",
      { mode: 0o755 },
    ),
    writeFile(
      path.join(binDirectory, "ffmpeg"),
      "#!/bin/sh\nsleep 30\n",
      { mode: 0o755 },
    ),
  ]);
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDirectory}${path.delimiter}${originalPath ?? ""}`;
  let pair: ActiveRecordingPair | undefined;
  try {
    const unexpected = new Promise<string>((resolve) => {
      void (async () => {
        pair = await startRecordingPair({
          runDirectory,
          attempt: 1,
          game: {
            display: ":98",
            keypressCommand: "true",
            compositorScreenshot: {
              command: "true",
              arguments: [],
              environment: process.env,
            },
            captureWayland: { output: "HEADLESS-1", environment: process.env },
            frozen: false,
            frozenProcessIds: [],
            pause: async () => [],
            resume: async () => [],
            close: async () => undefined,
          },
          dashboard: {
            display: ":99",
            close: async () => undefined,
          },
          audit: new AuditLog(runDirectory),
          onUnexpectedExit: resolve,
        });
      })().catch((error) => resolve(`startup failed: ${String(error)}`));
    });
    const message = await Promise.race([
      unexpected,
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
    ]);
    assert.match(message, /game recorder exited unexpectedly \(code=23/);
  } finally {
    process.env.PATH = originalPath;
    if (pair) {
      pair.stopping = true;
      await Promise.all([
        terminateTestProcess(pair.gameProcess),
        terminateTestProcess(pair.dashboardProcess),
      ]);
    }
  }
});

async function terminateTestProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
}
