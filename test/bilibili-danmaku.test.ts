import assert from "node:assert/strict";
import test from "node:test";
import { brotliCompressSync, deflateSync } from "node:zlib";
import {
  BilibiliDanmakuClient,
  type BilibiliWebSocket,
  decodeBilibiliDanmakuMessages,
  encodeBilibiliPacket,
  fetchBilibiliDanmakuConfiguration,
  parseBilibiliPackets,
  resolveBilibiliRoomId,
} from "../src/bilibili-danmaku.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fakeBilibiliFetch(calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push(url.toString());
    if (url.pathname.endsWith("/room_init")) {
      return jsonResponse({ code: 0, data: { room_id: 7654321 } });
    }
    if (url.pathname.endsWith("/getConf")) {
      return jsonResponse({
        code: 0,
        data: {
          token: "private-test-token",
          host_server_list: [
            { host: "broadcastlv.chat.bilibili.com", wss_port: 443 },
            { host: "example.invalid", wss_port: 2245 },
          ],
        },
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

test("resolves a short room ID and anonymously loads danmaku hosts", async () => {
  const calls: string[] = [];
  const fetcher = fakeBilibiliFetch(calls);
  assert.equal(await resolveBilibiliRoomId(1234, fetcher), 7654321);

  const configuration = await fetchBilibiliDanmakuConfiguration("1234", fetcher);
  assert.equal(configuration.roomId, 7654321);
  assert.equal(configuration.token, "private-test-token");
  assert.deepEqual(configuration.hosts, [
    { host: "broadcastlv.chat.bilibili.com", wssPort: 443 },
    { host: "example.invalid", wssPort: 2245 },
  ]);
  assert.ok(calls.some((url) => url.includes("room_id=7654321")));
  assert.ok(calls.some((url) => url.includes("platform=pc") && url.includes("player=web")));
});

test("encodes protocol headers and parses adjacent packets", () => {
  const first = encodeBilibiliPacket(2, "heartbeat", 1, 7);
  const second = encodeBilibiliPacket(8, { code: 0 });
  const packets = parseBilibiliPackets(Buffer.concat([first, second]));
  assert.equal(packets.length, 2);
  assert.deepEqual(
    packets.map(({ operation, version, sequence }) => ({ operation, version, sequence })),
    [
      { operation: 2, version: 1, sequence: 7 },
      { operation: 8, version: 1, sequence: 1 },
    ],
  );
  assert.equal(packets[0]?.payload.toString("utf8"), "heartbeat");
});

function danmakuEvent(text: string, userId: number, userName: string): object {
  return {
    cmd: "DANMU_MSG:4:0:2:2:2:0",
    info: [[], text, [userId, userName]],
  };
}

test("extracts only DANMU_MSG comments from plain, zlib, and brotli packets", () => {
  const plain = encodeBilibiliPacket(5, danmakuEvent("点歌 晴天", 101, "甲"), 0);
  const ignored = encodeBilibiliPacket(5, { cmd: "SEND_GIFT", data: {} }, 0);
  const zlib = encodeBilibiliPacket(
    5,
    deflateSync(encodeBilibiliPacket(5, danmakuEvent("点歌 夜曲", 102, "乙"), 0)),
    2,
  );
  const brotliNested = Buffer.concat([
    encodeBilibiliPacket(5, danmakuEvent("点歌 稻香", 103, "丙"), 0),
    ignored,
  ]);
  const brotli = encodeBilibiliPacket(5, brotliCompressSync(brotliNested), 3);

  assert.deepEqual(decodeBilibiliDanmakuMessages(Buffer.concat([plain, ignored, zlib, brotli])), [
    { text: "点歌 晴天", userId: 101, userName: "甲" },
    { text: "点歌 夜曲", userId: 102, userName: "乙" },
    { text: "点歌 稻香", userId: 103, userName: "丙" },
  ]);
});

class FakeWebSocket implements BilibiliWebSocket {
  binaryType = "blob";
  readyState = 0;
  readonly sent: Buffer[] = [];
  readonly #listeners = new Map<string, Array<(event: unknown) => void>>();

  send(data: Buffer): void {
    this.sent.push(Buffer.from(data));
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  receive(data: Buffer): void {
    this.emit("message", {
      data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    });
  }

  drop(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("client authenticates, heartbeats, emits comments, reconnects, and closes", async () => {
  const sockets: FakeWebSocket[] = [];
  const urls: string[] = [];
  const comments: unknown[] = [];
  const states: string[] = [];
  const client = new BilibiliDanmakuClient({
    roomId: 1234,
    onComment: (comment) => comments.push(comment),
    onState: (state) => states.push(state.phase),
    fetch: fakeBilibiliFetch([]),
    WebSocket: (url) => {
      urls.push(url);
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    },
    heartbeatIntervalMs: 60_000,
    reconnectBaseDelayMs: 1,
    reconnectMaxDelayMs: 1,
    random: () => 0.5,
    now: () => new Date("2026-09-11T01:02:03.000Z"),
  });

  await client.start();
  const first = sockets[0];
  assert.ok(first);
  assert.equal(first.binaryType, "arraybuffer");
  assert.equal(urls[0], "wss://broadcastlv.chat.bilibili.com/sub");
  first.open();
  assert.deepEqual(
    first.sent.flatMap((packet) => parseBilibiliPackets(packet).map(({ operation }) => operation)),
    [7, 2],
  );
  const authentication = JSON.parse(parseBilibiliPackets(first.sent[0]!)[0]!.payload.toString("utf8")) as {
    roomid: number;
    protover: number;
  };
  assert.deepEqual(authentication, {
    uid: 0,
    roomid: 7654321,
    protover: 3,
    buvid: "",
    platform: "web",
    type: 2,
    key: "private-test-token",
  });

  first.receive(
    Buffer.concat([
      encodeBilibiliPacket(8, { code: 0 }),
      encodeBilibiliPacket(5, danmakuEvent("点歌 晴天", 10086, "测试用户"), 0),
      encodeBilibiliPacket(5, { cmd: "INTERACT_WORD" }, 0),
    ]),
  );
  await settle();
  assert.equal(client.state.phase, "connected");
  assert.deepEqual(comments, [
    {
      text: "点歌 晴天",
      userId: 10086,
      userName: "测试用户",
      roomId: 7654321,
      receivedAt: "2026-09-11T01:02:03.000Z",
    },
  ]);

  first.drop();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sockets.length, 2);
  assert.equal(urls[1], "wss://example.invalid:2245/sub");
  assert.ok(states.includes("reconnecting"));

  client.close();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(client.state.phase, "closed");
  assert.equal(sockets.length, 2);
});

test("rejects malformed packet lengths without partial parsing", () => {
  const malformed = Buffer.alloc(16);
  malformed.writeUInt32BE(64, 0);
  malformed.writeUInt16BE(16, 4);
  assert.throws(() => parseBilibiliPackets(malformed), /Invalid Bilibili packet length/);
});
