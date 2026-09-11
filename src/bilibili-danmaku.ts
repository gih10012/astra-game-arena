import { brotliDecompressSync, inflateSync } from "node:zlib";

const HEADER_LENGTH = 16;
const AUTH_OPERATION = 7;
const AUTH_REPLY_OPERATION = 8;
const HEARTBEAT_OPERATION = 2;
const MESSAGE_OPERATION = 5;
const MAX_PACKET_DEPTH = 8;

export interface BilibiliDanmakuHost {
  host: string;
  wssPort: number;
}

export interface BilibiliDanmakuConfiguration {
  roomId: number;
  hosts: BilibiliDanmakuHost[];
  token: string;
}

export interface BilibiliDanmakuMessage {
  text: string;
  userId: number | string;
  userName: string;
}

export interface BilibiliDanmakuComment extends BilibiliDanmakuMessage {
  roomId: number;
  receivedAt: string;
}

export interface BilibiliPacket {
  operation: number;
  version: number;
  sequence: number;
  payload: Buffer;
}

export type BilibiliDanmakuPhase =
  | "idle"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "closed";

export interface BilibiliDanmakuState {
  phase: BilibiliDanmakuPhase;
  roomId: number | null;
  reconnectAttempt: number;
  error: string | null;
}

interface WebSocketMessageEvent {
  data: unknown;
}

export interface BilibiliWebSocket {
  binaryType: string;
  readonly readyState: number;
  send(data: Buffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: unknown) => void,
  ): void;
}

export interface BilibiliDanmakuClientOptions {
  roomId: number | string;
  onComment: (comment: BilibiliDanmakuComment) => void;
  onState?: (state: BilibiliDanmakuState) => void;
  onError?: (error: Error) => void;
  fetch?: typeof fetch;
  WebSocket?: (url: string) => BilibiliWebSocket;
  fetcher?: typeof fetch;
  webSocketFactory?: (url: string) => BilibiliWebSocket;
  heartbeatIntervalMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  random?: () => number;
  now?: () => Date;
}

interface RoomInitResponse {
  code?: number;
  data?: {
    room_id?: number;
  };
}

interface DanmakuConfigurationResponse {
  code?: number;
  data?: {
    token?: string;
    host?: string;
    wss_port?: number;
    host_server_list?: Array<{
      host?: string;
      wss_port?: number;
    }>;
  };
}

function positiveInteger(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

async function fetchJson<T>(fetcher: typeof fetch, url: URL): Promise<T> {
  const roomId = url.searchParams.get("id") ?? url.searchParams.get("room_id") ?? "";
  const response = await fetcher(url, {
    headers: {
      accept: "application/json",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      referer: roomId
        ? `https://live.bilibili.com/${encodeURIComponent(roomId)}`
        : "https://live.bilibili.com/",
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Bilibili API request failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function resolveBilibiliRoomId(
  roomId: number | string,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const requestedRoomId = positiveInteger(roomId, "Bilibili room ID");
  const url = new URL("https://api.live.bilibili.com/room/v1/Room/room_init");
  url.searchParams.set("id", String(requestedRoomId));
  const response = await fetchJson<RoomInitResponse>(fetcher, url);
  if (response.code !== 0) {
    throw new Error(`Bilibili room lookup failed with code ${String(response.code)}`);
  }
  return positiveInteger(response.data?.room_id ?? 0, "Canonical Bilibili room ID");
}

export async function fetchBilibiliDanmakuConfiguration(
  roomId: number | string,
  fetcher: typeof fetch = fetch,
): Promise<BilibiliDanmakuConfiguration> {
  const canonicalRoomId = await resolveBilibiliRoomId(roomId, fetcher);
  const url = new URL("https://api.live.bilibili.com/room/v1/Danmu/getConf");
  url.searchParams.set("room_id", String(canonicalRoomId));
  url.searchParams.set("platform", "pc");
  url.searchParams.set("player", "web");
  const response = await fetchJson<DanmakuConfigurationResponse>(fetcher, url);
  if (response.code !== 0) {
    throw new Error(`Bilibili danmaku configuration failed with code ${String(response.code)}`);
  }

  const token = response.data?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Bilibili danmaku configuration did not include an authentication token");
  }

  const hosts = (response.data?.host_server_list ?? [])
    .filter(
      (entry): entry is { host: string; wss_port?: number } =>
        typeof entry.host === "string" && entry.host.length > 0,
    )
    .map((entry) => ({
      host: entry.host,
      wssPort:
        typeof entry.wss_port === "number" && entry.wss_port > 0
          ? entry.wss_port
          : 443,
    }));
  if (hosts.length === 0 && typeof response.data?.host === "string") {
    hosts.push({
      host: response.data.host,
      wssPort:
        typeof response.data.wss_port === "number" && response.data.wss_port > 0
          ? response.data.wss_port
          : 443,
    });
  }
  if (hosts.length === 0) {
    throw new Error("Bilibili danmaku configuration did not include a WebSocket host");
  }

  return { roomId: canonicalRoomId, hosts, token };
}

export function encodeBilibiliPacket(
  operation: number,
  payload: Buffer | string | object = Buffer.alloc(0),
  version = 1,
  sequence = 1,
): Buffer {
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  const packet = Buffer.allocUnsafe(HEADER_LENGTH + body.length);
  packet.writeUInt32BE(packet.length, 0);
  packet.writeUInt16BE(HEADER_LENGTH, 4);
  packet.writeUInt16BE(version, 6);
  packet.writeUInt32BE(operation, 8);
  packet.writeUInt32BE(sequence, 12);
  body.copy(packet, HEADER_LENGTH);
  return packet;
}

export function decodeBilibiliPackets(
  input: Buffer | ArrayBuffer | ArrayBufferView,
  depth = 0,
): BilibiliPacket[] {
  if (depth > MAX_PACKET_DEPTH) {
    throw new Error("Bilibili packet nesting is too deep");
  }
  const buffer = toBuffer(input);
  const packets: BilibiliPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < HEADER_LENGTH) {
      throw new Error("Truncated Bilibili packet header");
    }
    const packetLength = buffer.readUInt32BE(offset);
    const headerLength = buffer.readUInt16BE(offset + 4);
    const version = buffer.readUInt16BE(offset + 6);
    const operation = buffer.readUInt32BE(offset + 8);
    const sequence = buffer.readUInt32BE(offset + 12);
    if (
      headerLength < HEADER_LENGTH ||
      packetLength < headerLength ||
      packetLength > buffer.length - offset
    ) {
      throw new Error("Invalid Bilibili packet length");
    }
    const payload = buffer.subarray(offset + headerLength, offset + packetLength);
    if (version === 2 || version === 3) {
      const decompressed =
        version === 2 ? inflateSync(payload) : brotliDecompressSync(payload);
      packets.push(...decodeBilibiliPackets(decompressed, depth + 1));
    } else {
      packets.push({ operation, version, sequence, payload: Buffer.from(payload) });
    }
    offset += packetLength;
  }
  return packets;
}

function toBuffer(input: Buffer | ArrayBuffer | ArrayBufferView): Buffer {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

export function decodeBilibiliDanmakuMessages(
  input: Buffer | ArrayBuffer | ArrayBufferView,
): BilibiliDanmakuMessage[] {
  const messages: BilibiliDanmakuMessage[] = [];
  for (const packet of decodeBilibiliPackets(input)) {
    if (packet.operation !== MESSAGE_OPERATION) continue;
    for (const raw of packet.payload.toString("utf8").split("\0")) {
      const text = raw.trim();
      if (text.length === 0) continue;
      let event: unknown;
      try {
        event = JSON.parse(text) as unknown;
      } catch {
        continue;
      }
      const message = danmakuMessageFromEvent(event);
      if (message) messages.push(message);
    }
  }
  return messages;
}

function danmakuMessageFromEvent(event: unknown): BilibiliDanmakuMessage | null {
  if (typeof event !== "object" || event === null) return null;
  const record = event as Record<string, unknown>;
  if (typeof record.cmd !== "string" || !record.cmd.startsWith("DANMU_MSG")) {
    return null;
  }
  if (!Array.isArray(record.info)) return null;
  const body = record.info[1];
  const sender = record.info[2];
  if (typeof body !== "string" || !Array.isArray(sender)) return null;
  const userId = sender[0];
  const userName = sender[1];
  if (
    (typeof userId !== "number" && typeof userId !== "string") ||
    typeof userName !== "string"
  ) {
    return null;
  }
  return { text: body, userId, userName };
}

export const parseBilibiliPackets = decodeBilibiliPackets;

function defaultWebSocketFactory(url: string): BilibiliWebSocket {
  return new WebSocket(url) as unknown as BilibiliWebSocket;
}

function webSocketUrl(host: BilibiliDanmakuHost): string {
  const authority = host.wssPort === 443 ? host.host : `${host.host}:${host.wssPort}`;
  return `wss://${authority}/sub`;
}

async function eventDataBuffer(data: unknown): Promise<Buffer | null> {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (
    typeof data === "object" &&
    data !== null &&
    "arrayBuffer" in data &&
    typeof (data as { arrayBuffer?: unknown }).arrayBuffer === "function"
  ) {
    return Buffer.from(await (data as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer());
  }
  return null;
}

export class BilibiliDanmakuClient {
  readonly #options: BilibiliDanmakuClientOptions;
  readonly #fetcher: typeof fetch;
  readonly #webSocketFactory: (url: string) => BilibiliWebSocket;
  readonly #random: () => number;
  readonly #now: () => Date;
  #configuration: BilibiliDanmakuConfiguration | null = null;
  #socket: BilibiliWebSocket | null = null;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #stopped = true;
  #hostCursor = 0;
  #reconnectAttempt = 0;
  #state: BilibiliDanmakuState = {
    phase: "idle",
    roomId: null,
    reconnectAttempt: 0,
    error: null,
  };

  constructor(options: BilibiliDanmakuClientOptions) {
    this.#options = options;
    this.#fetcher = options.fetch ?? options.fetcher ?? fetch;
    this.#webSocketFactory =
      options.WebSocket ?? options.webSocketFactory ?? defaultWebSocketFactory;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? (() => new Date());
  }

  get state(): BilibiliDanmakuState {
    return { ...this.#state };
  }

  async start(): Promise<void> {
    if (!this.#stopped) return;
    this.#stopped = false;
    await this.#initialize();
  }

  async #initialize(): Promise<void> {
    if (this.#stopped) return;
    this.#setState(this.#reconnectAttempt > 0 ? "reconnecting" : "connecting", null);
    try {
      this.#configuration = await fetchBilibiliDanmakuConfiguration(
        this.#options.roomId,
        this.#fetcher,
      );
      if (this.#stopped) return;
      this.#setState("connecting", null);
      this.#connect();
    } catch (error) {
      if (this.#stopped) return;
      this.#configuration = null;
      const normalized = asError(error);
      this.#scheduleReconnect(normalized);
    }
  }

  close(): void {
    if (this.#stopped && this.#state.phase === "closed") return;
    this.#stopped = true;
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      try {
        socket.close(1000, "client closed");
      } catch {
        // The socket is already gone.
      }
    }
    this.#setState("closed", null);
  }

  #connect(): void {
    const configuration = this.#configuration;
    if (this.#stopped || !configuration) return;
    const host = configuration.hosts[this.#hostCursor % configuration.hosts.length];
    this.#hostCursor += 1;
    if (!host) return;
    this.#setState(this.#reconnectAttempt > 0 ? "reconnecting" : "connecting", null);

    let socket: BilibiliWebSocket;
    try {
      socket = this.#webSocketFactory(webSocketUrl(host));
    } catch (error) {
      this.#scheduleReconnect(asError(error));
      return;
    }
    this.#socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      if (this.#stopped || this.#socket !== socket || !this.#configuration) return;
      this.#setState("authenticating", null);
      const authentication = {
        uid: 0,
        roomid: this.#configuration.roomId,
        protover: 3,
        buvid: "",
        platform: "web",
        type: 2,
        key: this.#configuration.token,
      };
      try {
        socket.send(encodeBilibiliPacket(AUTH_OPERATION, authentication));
        this.#sendHeartbeat(socket);
        this.#heartbeatTimer = setInterval(
          () => this.#sendHeartbeat(socket),
          this.#options.heartbeatIntervalMs ?? 30_000,
        );
      } catch (error) {
        this.#handleSocketFailure(socket, asError(error));
      }
    });
    socket.addEventListener("message", (event) => {
      if (this.#stopped || this.#socket !== socket) return;
      const data = (event as WebSocketMessageEvent).data;
      void this.#handleMessage(socket, data);
    });
    socket.addEventListener("error", () => {
      if (this.#stopped || this.#socket !== socket) return;
      this.#handleSocketFailure(socket, new Error("Bilibili danmaku WebSocket failed"));
    });
    socket.addEventListener("close", () => {
      if (this.#stopped || this.#socket !== socket) return;
      this.#socket = null;
      this.#clearHeartbeat();
      this.#scheduleReconnect(new Error("Bilibili danmaku WebSocket closed"));
    });
  }

  async #handleMessage(socket: BilibiliWebSocket, data: unknown): Promise<void> {
    try {
      const buffer = await eventDataBuffer(data);
      if (!buffer || this.#stopped || this.#socket !== socket) return;
      const packets = decodeBilibiliPackets(buffer);
      for (const packet of packets) {
        if (packet.operation !== AUTH_REPLY_OPERATION) continue;
        const reply = JSON.parse(packet.payload.toString("utf8")) as { code?: number };
        if (reply.code !== 0) {
          throw new Error(`Bilibili danmaku authentication failed with code ${String(reply.code)}`);
        }
        this.#reconnectAttempt = 0;
        this.#setState("connected", null);
      }
      for (const message of decodeBilibiliDanmakuMessages(buffer)) {
        try {
          this.#options.onComment({
            ...message,
            roomId: this.#configuration?.roomId ?? positiveInteger(this.#options.roomId, "room ID"),
            receivedAt: this.#now().toISOString(),
          });
        } catch (error) {
          this.#reportError(asError(error));
        }
      }
    } catch (error) {
      this.#handleSocketFailure(socket, asError(error));
    }
  }

  #sendHeartbeat(socket: BilibiliWebSocket): void {
    if (this.#stopped || this.#socket !== socket || socket.readyState !== 1) return;
    socket.send(encodeBilibiliPacket(HEARTBEAT_OPERATION, Buffer.from("[object Object]")));
  }

  #handleSocketFailure(socket: BilibiliWebSocket, error: Error): void {
    if (this.#stopped || this.#socket !== socket) return;
    this.#socket = null;
    this.#clearHeartbeat();
    try {
      socket.close();
    } catch {
      // Ignore close races; reconnect is already scheduled below.
    }
    this.#scheduleReconnect(error);
  }

  #scheduleReconnect(error: Error): void {
    if (this.#stopped || this.#reconnectTimer) return;
    this.#reconnectAttempt += 1;
    this.#setState("reconnecting", error.message);
    this.#reportError(error);
    const base = Math.max(1, this.#options.reconnectBaseDelayMs ?? 1_000);
    const maximum = Math.max(base, this.#options.reconnectMaxDelayMs ?? 30_000);
    const exponential = Math.min(maximum, base * 2 ** Math.min(20, this.#reconnectAttempt - 1));
    const jitter = 0.8 + this.#random() * 0.4;
    const delay = Math.max(1, Math.round(exponential * jitter));
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#configuration) this.#connect();
      else void this.#initialize();
    }, delay);
    this.#reconnectTimer.unref();
  }

  #setState(phase: BilibiliDanmakuPhase, error: string | null): void {
    this.#state = {
      phase,
      roomId: this.#configuration?.roomId ?? null,
      reconnectAttempt: this.#reconnectAttempt,
      error,
    };
    try {
      this.#options.onState?.({ ...this.#state });
    } catch {
      // State observers must not break the socket lifecycle.
    }
  }

  #reportError(error: Error): void {
    try {
      this.#options.onError?.(error);
    } catch {
      // Error observers must not break the socket lifecycle.
    }
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
  }

  #clearTimers(): void {
    this.#clearHeartbeat();
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
