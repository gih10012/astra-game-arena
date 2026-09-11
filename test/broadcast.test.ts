import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultBroadcastConfiguration,
  determineBroadcastPlayback,
  discoverBroadcastMedia,
  liveAudioFfmpegArguments,
  readBroadcastConfiguration,
  replayAudioFfmpegArguments,
  replayFfmpegArguments,
  replayMjpegFfmpegArguments,
  selectedBroadcastMedia,
  writeBroadcastConfiguration,
} from "../src/broadcast.js";

test("persists normalized broadcast controls outside tracked files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-broadcast-config-"));
  const written = await writeBroadcastConfiguration(root, {
    ...defaultBroadcastConfiguration(),
    mode: "replay",
    playlist: ["/tmp/a.mkv", "/tmp/a.mkv"],
    manualFiles: ["/tmp/a.mkv"],
    volume: 0.35,
    replayBadgeText: "  REPLAY  ",
  });
  const loaded = await readBroadcastConfiguration(root);
  assert.equal(loaded.mode, "replay");
  assert.deepEqual(loaded.playlist, ["/tmp/a.mkv"]);
  assert.equal(loaded.volume, 0.35);
  assert.equal(loaded.replayBadgeText, "REPLAY");
  assert.equal(loaded.updatedAt, written.updatedAt);
});

test("discovers run, library, and explicit manual replay media", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-broadcast-media-"));
  const manualRoot = await mkdtemp(path.join(os.tmpdir(), "arena-manual-media-"));
  await Promise.all([
    mkdir(path.join(root, ".arena", "broadcast-media"), { recursive: true }),
    mkdir(path.join(root, "runs", "run-a", "production"), { recursive: true }),
    mkdir(path.join(root, "runs", "run-a", "recordings"), { recursive: true }),
  ]);
  const libraryFile = path.join(root, ".arena", "broadcast-media", "intermission.mp4");
  const productionFile = path.join(root, "runs", "run-a", "production", "challenge-complete.mkv");
  const partFile = path.join(root, "runs", "run-a", "recordings", "challenge-part-0001.mkv");
  const ignored = path.join(root, "runs", "run-a", "recordings", "raw.mkv");
  const manualFile = path.join(manualRoot, "manual.webm");
  await Promise.all([
    writeFile(libraryFile, "library"), writeFile(productionFile, "production"),
    writeFile(partFile, "part"), writeFile(ignored, "ignored"), writeFile(manualFile, "manual"),
  ]);
  const media = await discoverBroadcastMedia(root, [manualFile]);
  assert.deepEqual(new Set(media.map((item) => item.name)), new Set([
    "intermission.mp4", "challenge-complete.mkv", "challenge-part-0001.mkv", "manual.webm",
  ]));
  const configuration = { ...defaultBroadcastConfiguration(), playlist: [partFile, productionFile] };
  assert.deepEqual(selectedBroadcastMedia(configuration, media).map((item) => item.name), [
    "challenge-part-0001.mkv", "challenge-complete.mkv",
  ]);
});

test("selects live, replay, and standby from the challenge state", () => {
  const configuration = defaultBroadcastConfiguration();
  assert.deepEqual(determineBroadcastPlayback({
    configuration, phase: "running", liveAvailable: true, hasReplay: true,
  }), { mode: "live", reason: "challenge-running" });
  assert.deepEqual(determineBroadcastPlayback({
    configuration, phase: "waiting_quota", liveAvailable: false, hasReplay: true,
  }), { mode: "replay", reason: "waiting_quota" });
  assert.deepEqual(determineBroadcastPlayback({
    configuration, phase: null, liveAvailable: false, hasReplay: false,
  }), { mode: "standby", reason: "playlist-empty" });
});

test("builds real-time browser-compatible replay and live-audio encoders", () => {
  const replay = replayFfmpegArguments("/tmp/movie with spaces.mkv");
  assert.ok(replay.includes("-re"));
  assert.ok(replay.includes("/tmp/movie with spaces.mkv"));
  assert.ok(replay.includes("frag_keyframe+empty_moov+default_base_moof"));
  assert.ok(replay.some((entry) => entry.includes("scale=1920:1080")));
  assert.ok(replay.includes("aac"));
  const mjpeg = replayMjpegFfmpegArguments(
    "/tmp/movie with spaces.mkv",
    "Account: One's",
  );
  assert.ok(mjpeg.includes("mjpeg"));
  assert.equal(mjpeg.at(-2), "mpjpeg");
  assert.ok(mjpeg.some((entry) => entry.includes("scale=1920:1080")));
  assert.ok(mjpeg.some((entry) => entry.includes("drawbox=x=19:y=1021")));
  assert.ok(mjpeg.some((entry) => entry.includes("Account\\: One\\'s")));
  const replayAudio = replayAudioFfmpegArguments("/tmp/movie with spaces.mkv");
  assert.ok(replayAudio.includes("libopus"));
  assert.equal(replayAudio.at(-2), "ogg");
  const audio = liveAudioFfmpegArguments("arena-sink.monitor");
  assert.ok(audio.includes("pulse"));
  assert.ok(audio.includes("arena-sink.monitor"));
  assert.ok(audio.includes("libopus"));
  assert.equal(audio.at(-2), "ogg");
});
