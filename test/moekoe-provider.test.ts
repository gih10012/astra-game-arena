import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import {
  MoeKoeProvider,
  parseKrcLyrics,
  type MusicTrack,
} from "../src/moekoe-provider.js";

test("parseKrcLyrics exposes line and word timing", () => {
  const parsed = parseKrcLyrics([
    "[ar:测试歌手]",
    "[2000,1600]<0,400,0>你<400,500,0>好<900,700,0>世界",
    "[500,800]<0,800,0>前奏",
    "[5000,900]无逐字时间",
  ].join("\n"));

  assert.deepEqual(parsed.map(({ startMs, durationMs, text }) => ({
    startMs,
    durationMs,
    text,
  })), [
    { startMs: 500, durationMs: 800, text: "前奏" },
    { startMs: 2_000, durationMs: 1_600, text: "你好世界" },
    { startMs: 5_000, durationMs: 900, text: "无逐字时间" },
  ]);
  assert.deepEqual(parsed[1]?.words[1], {
    startMs: 2_400,
    durationMs: 500,
    text: "好",
  });
});

test("provider scans newest LevelDB MoeData and never exposes credentials", async (context) => {
  const profile = await fs.mkdtemp(path.join(tmpdir(), "astra-moekoe-profile-"));
  context.after(() => fs.rm(profile, { recursive: true, force: true }));
  const leveldb = path.join(profile, "Local Storage", "leveldb");
  await fs.mkdir(leveldb, { recursive: true });
  const old = path.join(leveldb, "000001.ldb");
  const latest = path.join(leveldb, "000002.log");
  await fs.writeFile(old, Buffer.concat([
    Buffer.from([0, 1, 2]),
    Buffer.from('MoeData\u0001{"UserInfo":{"token":"old"}}trailer'),
  ]));
  await fs.writeFile(latest, Buffer.concat([
    Buffer.from([4, 5]),
    Buffer.from('MoeData\u0001{"UserInfo":{"token":"secret-{\\\"x\\\"}","userid":42,"t1":"ticket"},"Device":{"dfid":"device"}}tail'),
  ]));
  const future = new Date(Date.now() + 2_000);
  await fs.utimes(latest, future, future);

  let authorization = "";
  const provider = new MoeKoeProvider({
    baseUrl: "http://music.test",
    profileDirectory: profile,
    fetch: async (input, init) => {
      authorization = new Headers(init?.headers).get("Authorization") ?? "";
      assert.match(String(input), /\/search\?/);
      return jsonResponse({
        status: 1,
        data: {
          lists: [{
            FileHash: "HASH-1",
            FileName: "歌手 - 歌名",
            SingerName: "歌手",
            Duration: 201,
          }],
        },
      });
    },
  });

  const tracks = await provider.search("歌名", 3);
  assert.equal(authorization, "token=secret-{\"x\"};userid=42;dfid=device;t1=ticket");
  assert.deepEqual(tracks, [{
    id: "HASH-1",
    hash: "HASH-1",
    title: "歌名",
    artist: "歌手",
    source: "moekoe",
    durationMs: 201_000,
    durationSeconds: 201,
  }]);
  assert.doesNotMatch(JSON.stringify(provider), /secret|ticket|device/);
});

test("provider handles recommendations, playback resolution, lyrics, and VIP", async () => {
  const requests: URL[] = [];
  const provider = new MoeKoeProvider({
    baseUrl: "http://music.test/api",
    profileDirectory: "/missing-profile",
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === "/api/top/card") {
        return jsonResponse({ status: 1, data: { song_list: [{
          hash: "BASE",
          songname: "每日歌",
          author_name: "每日歌手",
          time_length: 123_456,
          sizable_cover: "https://img/{size}.jpg",
        }] } });
      }
      if (url.pathname === "/api/privilege/lite") {
        return jsonResponse({ data: [{
          hash: "BASE",
          quality: "128",
          level: 1,
          relate_goods: [{ hash: "HQ", quality: "320", level: 1 }],
        }] });
      }
      if (url.pathname === "/api/song/url") {
        if (url.searchParams.get("quality") === "320") {
          return jsonResponse({ status: 1, extName: "mp3", url: ["https://audio/song.mp3"] });
        }
        return jsonResponse({ status: 3 });
      }
      if (url.pathname === "/api/search/lyric") {
        return jsonResponse({ status: 200, candidates: [{ id: 7, accesskey: "access" }] });
      }
      if (url.pathname === "/api/lyric") {
        return jsonResponse({ status: 200, decodeContent: "[100,500]<0,500,0>歌词" });
      }
      if (url.pathname === "/api/youth/vip") {
        return jsonResponse({ status: 1, data: { award_vip_hour: 3 } });
      }
      return new Response(null, { status: 404 });
    },
  });

  const [track] = await provider.dailyRecommendations(2);
  assert.deepEqual(track, {
    id: "BASE",
    hash: "BASE",
    title: "每日歌",
    artist: "每日歌手",
    source: "moekoe",
    durationMs: 123_456,
    durationSeconds: 123.456,
    artworkUrl: "https://img/480.jpg",
  });
  const playable = await provider.resolvePlayable(track!);
  assert.equal(playable.url, "https://audio/song.mp3");
  assert.equal(playable.resolvedHash, "HQ");
  assert.equal(playable.quality, "320");
  assert.equal((await provider.lyrics(track!))[0]?.text, "歌词");
  assert.deepEqual(await provider.claimVip(), { claimed: true, hours: 3 });
  assert.equal(requests[0]?.searchParams.get("card_id"), "2");
  assert.equal(requests.find((url) => url.pathname === "/api/song/url")?.searchParams.get("ppage_id"), "356753938");
});

test("start manages an injected local API process without requiring MoeKoe installation", async (context) => {
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const fake = new EventEmitter() as ChildProcess;
  Object.defineProperties(fake, {
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
  });
  const signals: (NodeJS.Signals | number | undefined)[] = [];
  fake.kill = ((signal?: NodeJS.Signals | number) => {
    signals.push(signal);
    (fake as ChildProcess & { exitCode: number | null }).exitCode = 0;
    queueMicrotask(() => fake.emit("exit", 0, null));
    return true;
  }) as ChildProcess["kill"];
  let invocation: { command: string; args: readonly string[] } | null = null;
  const provider = new MoeKoeProvider({
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    manageProcess: true,
    apiBinaryPath: "/fake/app_linux",
    spawn: (command, args) => {
      invocation = { command, args };
      return fake;
    },
  });

  // Healthy custom services are reused without spawning.
  await provider.start();
  assert.equal(invocation, null);
  await new Promise<void>((resolve) => server.close(() => resolve()));

  // Force the managed start path while keeping health deterministic.
  let healthCalls = 0;
  const managed = new MoeKoeProvider({
    baseUrl: "http://127.0.0.1:16599",
    port: 16_599,
    manageProcess: true,
    apiBinaryPath: "/fake/app_linux",
    startupTimeoutMs: 1_000,
    fetch: async () => {
      healthCalls += 1;
      if (healthCalls === 1) throw new Error("not started");
      return new Response(null, { status: 404 });
    },
    spawn: (command, args) => {
      invocation = { command, args };
      return fake;
    },
  });
  await managed.start();
  assert.deepEqual(invocation, {
    command: "/fake/app_linux",
    args: ["--platform=lite", "--port=16599"],
  });
  await managed.close();
  assert.deepEqual(signals, ["SIGTERM"]);
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
