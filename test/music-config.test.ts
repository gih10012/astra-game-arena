import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultMusicConfiguration,
  musicConfigPath,
  patchMusicConfiguration,
  readMusicConfiguration,
  writeMusicConfiguration,
} from "../src/music-config.js";

test("music configuration is bounded and durably persisted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-music-config-"));
  const defaults = await readMusicConfiguration(root);
  assert.equal(defaults.roomId, "1912485907");
  assert.equal(defaults.enabled, false);
  const changed = patchMusicConfiguration(defaults, {
    enabled: true,
    musicVolume: 9,
    hintIntervalSeconds: 0,
    queueOverlayMode: "always",
    ignoredSecret: "do not persist",
  });
  const saved = await writeMusicConfiguration(root, changed);
  assert.equal(saved.musicVolume, 1);
  assert.equal(saved.hintIntervalSeconds, 0);
  assert.equal(saved.queueOverlayMode, "always");
  const raw = await readFile(musicConfigPath(root), "utf8");
  assert.doesNotMatch(raw, /ignoredSecret/);
  assert.deepEqual(await readMusicConfiguration(root), saved);
});

test("invalid provider values fall back without losing safe defaults", () => {
  const value = patchMusicConfiguration(defaultMusicConfiguration(), {
    provider: "unknown",
    roomId: "",
    providerBaseUrl: "file:///tmp/nope",
    lyricsXPercent: -5,
    maxQueueLength: 999,
  });
  assert.equal(value.provider, "moekoe");
  assert.equal(value.roomId, "1912485907");
  assert.match(value.providerBaseUrl, /^http:/);
  assert.equal(value.lyricsXPercent, 0);
  assert.equal(value.maxQueueLength, 200);
});
