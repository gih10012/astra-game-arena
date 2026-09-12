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

test("daily playback remains ready when danmaku initialization fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-music-service-"));
  await writeMusicConfiguration(root, { ...defaultMusicConfiguration(), enabled: true });
  const track: MusicTrack = {
    id: "daily-1", hash: "daily-1", title: "每日歌曲", artist: "歌手", source: "test",
  };
  const provider: MusicProvider = {
    id: "test",
    start: async () => undefined,
    health: async () => true,
    healthy: async () => true,
    search: async () => [],
    dailyRecommendations: async () => [track],
    resolvePlayable: async () => ({ ...track, url: "https://example.invalid/song.mp3", resolvedHash: track.hash, quality: "128" }),
    lyrics: async () => [],
    prepareTrack: async () => ({ track, url: "https://example.invalid/song.mp3", resolvedHash: track.hash, quality: "128", lyrics: [] }),
    claimVip: async () => ({ claimed: false }),
    close: async () => undefined,
  };
  const service = await MusicService.open(root, () => undefined, {
    providerFactory: () => provider,
    danmakuFactory: (_configuration, callbacks) => ({
      start: async () => {
        callbacks.onState({
          phase: "reconnecting", roomId: null, reconnectAttempt: 1, error: "fetch failed",
        });
      },
      close: () => undefined,
    }) as never,
    pulse: false,
  });

  await service.activate();
  await settle();
  assert.equal(service.snapshot.runtime.phase, "ready");
  assert.equal(service.snapshot.runtime.provider, "ready");
  assert.equal(service.snapshot.runtime.audio, "playing");
  assert.equal(service.snapshot.runtime.danmaku.phase, "reconnecting");
  assert.equal(service.snapshot.current?.track.id, "daily-1");
  await service.close();
});

test("daily playback retries after a transient recommendation failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-music-service-"));
  await writeMusicConfiguration(root, { ...defaultMusicConfiguration(), enabled: true });
  const track: MusicTrack = {
    id: "daily-retry", hash: "daily-retry", title: "恢复播放", artist: "歌手", source: "test",
  };
  let attempts = 0;
  const provider: MusicProvider = {
    id: "test",
    start: async () => undefined,
    health: async () => true,
    healthy: async () => true,
    search: async () => [],
    dailyRecommendations: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary upstream failure");
      return [track];
    },
    resolvePlayable: async () => ({ ...track, url: "https://example.invalid/song.mp3", resolvedHash: track.hash, quality: "128" }),
    lyrics: async () => [],
    prepareTrack: async () => ({ track, url: "https://example.invalid/song.mp3", resolvedHash: track.hash, quality: "128", lyrics: [] }),
    claimVip: async () => ({ claimed: false }),
    close: async () => undefined,
  };
  const service = await MusicService.open(root, () => undefined, {
    providerFactory: () => provider,
    danmakuFactory: () => ({ start: async () => undefined, close: () => undefined }) as never,
    pulse: false,
    retryDelayMs: 100,
  });

  await service.activate();
  const initial = service.snapshot;
  assert.equal(initial.current, null);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(attempts, 2);
  const recovered = service.snapshot;
  assert.equal(recovered.current?.track.id, "daily-retry");
  assert.equal(recovered.runtime.audio, "playing");
  assert.equal(recovered.runtime.error, null);
  await service.close();
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
