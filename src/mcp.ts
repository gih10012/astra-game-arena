#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { allowedKeys } from "./types.js";

const arenaUrl = process.env.ARENA_URL;
const controlToken = process.env.ARENA_CONTROL_TOKEN;
if (!arenaUrl || !controlToken) {
  throw new Error("ARENA_URL and ARENA_CONTROL_TOKEN are required");
}

interface FramePayload {
  data: string;
  mimeType: "image/png" | "image/jpeg";
  sha256: string;
  capturedAt: string;
}

async function request<T>(pathname: string, body?: unknown): Promise<T> {
  const response = await fetch(new URL(pathname, arenaUrl), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${controlToken}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`${pathname}: HTTP ${response.status}${message ? `: ${message}` : ""}`);
  }
  return await response.json() as T;
}

function frameContent(frame: FramePayload, detail: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(detail) },
      { type: "image" as const, data: frame.data, mimeType: frame.mimeType },
    ],
  };
}

const server = new McpServer({ name: "game-arena", version: "0.2.0" });

server.registerTool(
  "observe_screen",
  {
    title: "Observe private game screen",
    description: "Capture the current 1280x1080 native game screen.",
    inputSchema: {},
  },
  async () => {
    const frame = await request<FramePayload>("/internal/observe", {});
    return frameContent(frame, { sha256: frame.sha256, capturedAt: frame.capturedAt });
  },
);

server.registerTool(
  "press_keys",
  {
    title: "Press game keys",
    description: "Press a sequence of keys in the isolated game and return the resulting screen.",
    inputSchema: {
      keys: z.array(z.enum(allowedKeys)).min(1).max(512),
      intervalMs: z.number().int().min(0).max(1_000).default(55),
      settleMs: z.number().int().min(0).max(2_000).default(100),
    },
  },
  async ({ keys, intervalMs, settleMs }) => {
    const result = await request<{ pressed: number; frame: FramePayload }>(
      "/internal/press",
      { keys, intervalMs, settleMs, capture: true },
    );
    return frameContent(result.frame, { pressed: result.pressed });
  },
);

server.registerTool(
  "type_text",
  {
    title: "Type text into game",
    description: "Type printable ASCII text into the focused game UI and return the resulting screen.",
    inputSchema: {
      text: z.string().min(1).max(4_096),
      intervalMs: z.number().int().min(0).max(500).default(25),
      settleMs: z.number().int().min(0).max(2_000).default(100),
    },
  },
  async ({ text, intervalMs, settleMs }) => {
    const result = await request<{ typed: number; frame: FramePayload }>(
      "/internal/type",
      { text, intervalMs, settleMs },
    );
    return frameContent(result.frame, { typed: result.typed });
  },
);

server.registerTool(
  "mouse",
  {
    title: "Use game mouse",
    description:
      "Move, click, drag, or scroll the isolated game pointer using 1280x1080 screen coordinates; returns the resulting screen.",
    inputSchema: {
      action: z.enum(["move", "click", "drag", "scroll"]),
      x: z.number().int().min(0).max(1_279),
      y: z.number().int().min(0).max(1_079),
      button: z.enum(["left", "middle", "right"]).default("left"),
      count: z.number().int().min(1).max(3).default(1),
      toX: z.number().int().min(0).max(1_279).optional(),
      toY: z.number().int().min(0).max(1_079).optional(),
      durationMs: z.number().int().min(0).max(5_000).default(500),
      deltaX: z.number().int().min(-100).max(100).default(0),
      deltaY: z.number().int().min(-100).max(100).default(0),
      settleMs: z.number().int().min(0).max(2_000).default(100),
    },
  },
  async (input) => {
    const result = await request<{ action: string; frame: FramePayload }>(
      "/internal/pointer",
      input,
    );
    return frameContent(result.frame, { action: result.action });
  },
);

for (const tool of [
  {
    name: "challenge_time",
    title: "Challenge time",
    description: "Return active challenge time; paused, quota, sleep, and reboot gaps are excluded.",
    path: "/api/challenge/time",
  },
  {
    name: "challenge_tokens",
    title: "Challenge token usage",
    description: "Return cumulative input, cached input, output, reasoning, and total token usage.",
    path: "/api/challenge/tokens",
  },
] as const) {
  server.registerTool(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: {} },
    async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(await request(tool.path)) }],
    }),
  );
}

server.registerTool(
  "complete_challenge",
  {
    title: "Declare goal complete",
    description:
      "Call only after visually verifying that the natural-language goal is fully achieved. This stops the challenge and preserves final evidence.",
    inputSchema: { summary: z.string().min(3).max(4_000) },
  },
  async ({ summary }) => {
    const result = await request<{ completed: boolean; summary: string; frame: FramePayload }>(
      "/internal/complete",
      { summary },
    );
    return frameContent(result.frame, { completed: result.completed, summary: result.summary });
  },
);

await server.connect(new StdioServerTransport());
