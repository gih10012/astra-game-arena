import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BilibiliDanmakuState } from "../src/bilibili-danmaku.js";
import { MusicService, parseMusicRequest } from "../src/music-service.js";
import { writeMusicConfiguration, defaultMusicConfiguration } from "../src/music-config.js";
import type { MusicProvider, MusicTrack } from "../src/moekoe-provider.js";

test("parses configured music command without matching lookalikes", () => {
  assert.equal(parseMusicRequest("点歌 晴天", "点歌"), "晴天");
  assert.equal(parseMusicRequest(" 点歌：夜曲 ", "点歌"), "夜曲");
  assert.equal(parseMusicRequest("想点歌 晴天", "点歌"), null);
  assert.equal(parseMusicRequest("点歌", "点歌"), null);
});

test("music queue rejects current and queued duplicate tracks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-music-service-"));
  await writeMusicConfiguration(root, { ...defaultMusicConfiguration(), enabled: true });
  const track: MusicTrack = {
    id: "song-1", hash: "song-1", title: "晴天", artist: "周杰伦", source: "test",
  };
  const provider: MusicProvider = {
    id: "test",
    start: async () => undefined,
    health: async () => true,
    healthy: async () => true,
    search: async () => [track],
    dailyRecommendations: async () => [],
    resolvePlayable: async () => ({ ...track, url: "https://example.invalid/song.mp3", resolvedHash: track.hash, quality: "128" }),
    lyrics: async () => [],
    prepareTrack: async () => ({ track, url: "https://example.invalid/song.mp3", resolvedHash: track.hash, quality: "128", lyrics: [] }),
    claimVip: async () => ({ claimed: true, hours: 3 }),
    close: async () => undefined,
  };
  const danmaku = {
    start: async () => undefined,
    close: () => undefined,
  };
  const service = await MusicService.open(root, () => undefined, {
    providerFactory: () => provider,
    danmakuFactory: (_configuration, callbacks) => {
      callbacks.onState({ phase: "connected", roomId: 1, reconnectAttempt: 0, error: null } satisfies BilibiliDanmakuState);
      return danmaku as never;
    },
    pulse: false,
  });
  await service.activate();
  await service.requestSong("晴天", "alice");
  await assert.rejects(service.requestSong("晴天", "bob"), /已在播放或队列中/);
  assert.equal(service.snapshot.current?.track.id, "song-1");
  assert.equal(service.snapshot.current?.requestedBy, "alice");
  await service.close();
});
