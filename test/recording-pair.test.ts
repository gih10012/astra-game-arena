import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { expectCommand } from "../src/command.js";
import { composeRecordingPair } from "../src/recording-pair.js";

test("composes native game and transcript streams into CFR 1920x1080 video", async () => {
  const runDirectory = await mkdtemp(path.join(os.tmpdir(), "game-arena-recording-"));
  const rawDirectory = path.join(runDirectory, "recordings", "raw");
  await mkdir(rawDirectory, { recursive: true });
  const game = path.join(rawDirectory, "game-part-0001.mkv");
  const dashboard = path.join(rawDirectory, "dashboard-part-0001.mkv");
  await Promise.all([
    expectCommand("ffmpeg", [
      "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30",
      "-t", "0.5", "-c:v", "libx264", "-preset", "ultrafast", game,
    ]),
    expectCommand("ffmpeg", [
      "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=navy:size=640x1080:rate=30",
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
});
