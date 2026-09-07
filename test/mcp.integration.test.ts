import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ChallengeState } from "../src/challenge-state.js";
import { ArenaController } from "../src/controller.js";
import { MockGameAdapter } from "../src/game-adapter.js";

test("exposes the private-screen computer-use and accounting tools over MCP", async (context) => {
  const state = new ChallengeState();
  const game = new MockGameAdapter();
  const controller = new ArenaController({ state, game, port: 0 });
  const url = await controller.listen();
  state.start("mcp-test");
  context.after(() => controller.close());

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.resolve("src/mcp.ts")],
    env: {
      ...process.env,
      ARENA_URL: url,
      ARENA_CONTROL_TOKEN: controller.controlToken,
    },
  });
  const client = new Client({ name: "arena-test", version: "1.0.0" });
  await client.connect(transport);
  context.after(() => client.close());

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    [
      "challenge_time",
      "challenge_tokens",
      "complete_challenge",
      "mouse",
      "observe_screen",
      "press_keys",
      "type_text",
    ],
  );
  const time = await client.callTool({ name: "challenge_time", arguments: {} });
  assert.equal(time.isError, undefined);
  const observe = await client.callTool({ name: "observe_screen", arguments: {} });
  assert.ok(Array.isArray(observe.content));
  assert.equal(observe.content[1]?.type, "image");
  await client.callTool({
    name: "press_keys",
    arguments: { keys: ["UP", "RIGHT"] },
  });
  assert.deepEqual(game.presses, [["UP", "RIGHT"]]);
});
