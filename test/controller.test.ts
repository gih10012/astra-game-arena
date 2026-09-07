import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChallengeState } from "../src/challenge-state.js";
import { ArenaController } from "../src/controller.js";
import { MockGameAdapter } from "../src/game-adapter.js";
import type { GameFrame } from "../src/types.js";

test("serves public metrics and protects game controls", async (context) => {
  const webRoot = await mkdtemp(path.join(os.tmpdir(), "arena-web-"));
  await Promise.all([
    writeFile(path.join(webRoot, "index.html"), "ok"),
    writeFile(path.join(webRoot, "app.js"), ""),
    writeFile(path.join(webRoot, "styles.css"), ""),
    writeFile(path.join(webRoot, "game.html"), ""),
    writeFile(path.join(webRoot, "game.js"), ""),
  ]);
  const state = new ChallengeState();
  const game = new MockGameAdapter();
  const controller = new ArenaController({ state, game, port: 0, webRoot });
  const url = await controller.listen();
  context.after(() => controller.close());
  state.start("test-run");

  assert.equal((await fetch(`${url}/health`)).status, 200);
  const time = await fetch(`${url}/api/challenge/time`).then((response) =>
    response.json(),
  );
  assert.equal(time.status, "running");

  assert.equal(
    (await fetch(`${url}/internal/observe`, { method: "POST" })).status,
    401,
  );
  const headers = {
    Authorization: `Bearer ${controller.controlToken}`,
    "Content-Type": "application/json",
  };
  const frame = await fetch(`${url}/internal/observe`, {
    method: "POST",
    headers,
    body: "{}",
  }).then((response) => response.json());
  assert.equal(frame.mimeType, "image/png");
  assert.ok(frame.data.length > 20);

  const press = await fetch(`${url}/internal/press`, {
    method: "POST",
    headers,
    body: JSON.stringify({ keys: ["UP", "LEFT"], capture: false }),
  }).then((response) => response.json());
  assert.equal(press.pressed, 2);
  assert.deepEqual(game.presses, [["UP", "LEFT"]]);
});

test("serves a durable holding frame before the live game is restored", async (context) => {
  const webRoot = await mkdtemp(path.join(os.tmpdir(), "arena-web-"));
  await Promise.all([
    writeFile(path.join(webRoot, "index.html"), "ok"),
    writeFile(path.join(webRoot, "app.js"), ""),
    writeFile(path.join(webRoot, "styles.css"), ""),
    writeFile(path.join(webRoot, "game.html"), ""),
    writeFile(path.join(webRoot, "game.js"), ""),
  ]);
  const holdingData = Buffer.from("durable-snapshot");
  const holdingFrame: GameFrame = {
    data: holdingData,
    mimeType: "image/jpeg",
    sha256: "holding-frame",
    capturedAt: "2026-09-07T00:00:00.000Z",
  };
  const liveData = Buffer.from("restored-live-frame");
  const controller = new ArenaController({
    state: new ChallengeState(),
    game: new MockGameAdapter(),
    initialFrame: holdingFrame,
    port: 0,
    webRoot,
  });
  const url = await controller.listen();
  context.after(() => controller.close());

  assert.equal(await fetch(`${url}/api/frame`).then((response) => response.text()), "durable-snapshot");
  controller.publishFrame({ ...holdingFrame, data: liveData, sha256: "live-frame" });
  assert.equal(await fetch(`${url}/api/frame`).then((response) => response.text()), "restored-live-frame");
});

test("cancels a batched key sequence after the in-flight batch", async (context) => {
  const webRoot = await mkdtemp(path.join(os.tmpdir(), "arena-web-"));
  await Promise.all([
    writeFile(path.join(webRoot, "index.html"), "ok"),
    writeFile(path.join(webRoot, "app.js"), ""),
    writeFile(path.join(webRoot, "styles.css"), ""),
    writeFile(path.join(webRoot, "game.html"), ""),
    writeFile(path.join(webRoot, "game.js"), ""),
  ]);
  const game = new MockGameAdapter();
  let releaseFirstPress = () => {};
  let markFirstPressStarted = () => {};
  const firstPressStarted = new Promise<void>((resolve) => {
    markFirstPressStarted = resolve;
  });
  game.press = async (keys) => {
    game.presses.push([...keys]);
    markFirstPressStarted();
    await new Promise<void>((resolve) => {
      releaseFirstPress = resolve;
    });
  };
  const controller = new ArenaController({
    state: new ChallengeState(),
    game,
    port: 0,
    webRoot,
  });
  const url = await controller.listen();
  context.after(() => controller.close());
  const request = fetch(`${url}/internal/press`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${controller.controlToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ keys: ["UP", "LEFT", "DOWN"] }),
  });
  await firstPressStarted;
  controller.cancelPendingActions();
  releaseFirstPress();

  assert.equal((await request).status, 500);
  assert.deepEqual(game.presses, [["UP", "LEFT", "DOWN"]]);
});
