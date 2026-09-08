import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  let supervisorVersion = 0;
  const controller = new ArenaController({
    state,
    game,
    port: 0,
    webRoot,
    supervisorProvider: () => ({ version: ++supervisorVersion }),
  });
  const url = await controller.listen();
  context.after(() => controller.close());
  state.start("test-run");

  assert.equal((await fetch(`${url}/health`)).status, 200);
  const time = await fetch(`${url}/api/challenge/time`).then((response) =>
    response.json(),
  );
  assert.equal(time.status, "running");
  assert.deepEqual(
    await fetch(`${url}/api/supervisor`).then((response) => response.json()),
    { version: 1 },
  );
  assert.deepEqual(
    await fetch(`${url}/api/supervisor`).then((response) => response.json()),
    { version: 2 },
  );

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

  const click = await fetch(`${url}/internal/pointer`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "click", x: 1_919, y: 1_079, settleMs: 0 }),
  });
  assert.equal(click.status, 200);
  assert.deepEqual(game.pointerActions, [{
    action: "click", x: 1_919, y: 1_079, button: "left", count: 1,
  }]);

  const outside = await fetch(`${url}/internal/pointer`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "click", x: 1_920, y: 1_079, settleMs: 0 }),
  });
  assert.equal(outside.status, 500);
});

test("serves live supervisor state to the private director", async (context) => {
  const webRoot = await mkdtemp(path.join(os.tmpdir(), "arena-web-"));
  await Promise.all([
    writeFile(path.join(webRoot, "index.html"), "ok"),
    writeFile(path.join(webRoot, "app.js"), ""),
    writeFile(path.join(webRoot, "styles.css"), ""),
  ]);
  let recordingActive = false;
  const controller = new ArenaController({
    state: new ChallengeState(),
    game: new MockGameAdapter(),
    port: 0,
    webRoot,
    supervisorProvider: () => ({
      active: true,
      recording: { active: recordingActive },
      virtualCamera: { active: true, device: "/dev/video10" },
    }),
  });
  const url = await controller.listen();
  context.after(() => controller.close());

  const first = await fetch(`${url}/api/supervisor`).then((response) => response.json());
  assert.equal(first.recording.active, false);
  assert.equal(first.virtualCamera.device, "/dev/video10");

  recordingActive = true;
  const second = await fetch(`${url}/api/supervisor`).then((response) => response.json());
  assert.equal(second.recording.active, true);
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

test("shares one live MJPEG producer across monitor subscribers", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-live-stream-"));
  const webRoot = path.join(root, "web");
  const bin = path.join(root, "bin");
  await Promise.all([mkdir(webRoot), mkdir(bin)]);
  await Promise.all([
    writeFile(path.join(webRoot, "index.html"), "ok"),
    writeFile(path.join(webRoot, "app.js"), ""),
    writeFile(path.join(webRoot, "styles.css"), ""),
  ]);
  const wfCount = path.join(root, "wf-count");
  const encoderCount = path.join(root, "encoder-count");
  const wfPid = path.join(root, "wf-pid");
  const encoderPid = path.join(root, "encoder-pid");
  const wfRecorder = path.join(bin, "wf-recorder");
  const ffmpeg = path.join(bin, "ffmpeg");
  await Promise.all([
    writeFile(wfRecorder, `#!/usr/bin/node
const fs = require("node:fs");
fs.appendFileSync(process.env.ARENA_WF_COUNT, "1\\n");
fs.writeFileSync(process.env.ARENA_WF_PID, String(process.pid));
setInterval(() => process.stdout.write("transport"), 20);
`),
    writeFile(ffmpeg, `#!/usr/bin/node
const fs = require("node:fs");
fs.appendFileSync(process.env.ARENA_ENCODER_COUNT, "1\\n");
fs.writeFileSync(process.env.ARENA_ENCODER_PID, String(process.pid));
process.stdin.resume();
setInterval(() => process.stdout.write("--ffmpeg\\r\\nContent-Type: image/jpeg\\r\\nContent-Length: 4\\r\\n\\r\\nFAKE\\r\\n"), 20);
`),
  ]);
  await Promise.all([chmod(wfRecorder, 0o755), chmod(ffmpeg, 0o755)]);

  const previous = {
    path: process.env.PATH,
    wfCount: process.env.ARENA_WF_COUNT,
    encoderCount: process.env.ARENA_ENCODER_COUNT,
    wfPid: process.env.ARENA_WF_PID,
    encoderPid: process.env.ARENA_ENCODER_PID,
  };
  process.env.PATH = `${bin}:${previous.path ?? ""}`;
  process.env.ARENA_WF_COUNT = wfCount;
  process.env.ARENA_ENCODER_COUNT = encoderCount;
  process.env.ARENA_WF_PID = wfPid;
  process.env.ARENA_ENCODER_PID = encoderPid;
  const restoreEnvironment = () => {
    restoreEnvironmentValue("PATH", previous.path);
    restoreEnvironmentValue("ARENA_WF_COUNT", previous.wfCount);
    restoreEnvironmentValue("ARENA_ENCODER_COUNT", previous.encoderCount);
    restoreEnvironmentValue("ARENA_WF_PID", previous.wfPid);
    restoreEnvironmentValue("ARENA_ENCODER_PID", previous.encoderPid);
  };
  context.after(restoreEnvironment);

  const controller = new ArenaController({
    state: new ChallengeState(),
    game: new MockGameAdapter(),
    port: 0,
    webRoot,
    liveCaptureWayland: {
      output: "HEADLESS-1",
      environment: { ...process.env },
    },
  });
  const url = await controller.listen();
  context.after(() => controller.close());

  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const [first, second] = await Promise.all([
    fetch(`${url}/api/live.mjpeg`, { signal: firstAbort.signal }),
    fetch(`${url}/api/live.mjpeg`, { signal: secondAbort.signal }),
  ]);
  assert.equal(first.headers.get("content-type"), "multipart/x-mixed-replace; boundary=ffmpeg");
  assert.equal(second.status, 200);
  const firstReader = first.body!.getReader();
  const secondReader = second.body!.getReader();
  await Promise.all([firstReader.read(), secondReader.read()]);
  assert.equal(await lineCount(wfCount), 1);
  assert.equal(await lineCount(encoderCount), 1);

  firstAbort.abort();
  assert.equal((await secondReader.read()).done, false);
  assert.equal(await lineCount(wfCount), 1);
  assert.equal(await lineCount(encoderCount), 1);

  secondAbort.abort();
  const firstPids = [
    Number(await readFile(wfPid, "utf8")),
    Number(await readFile(encoderPid, "utf8")),
  ];
  await waitFor(() => firstPids.every((pid) => !processAlive(pid)));

  const thirdAbort = new AbortController();
  const third = await fetch(`${url}/api/live.mjpeg`, { signal: thirdAbort.signal });
  const thirdReader = third.body!.getReader();
  await thirdReader.read();
  assert.equal(await lineCount(wfCount), 2);
  assert.equal(await lineCount(encoderCount), 2);
  thirdAbort.abort();
});

async function lineCount(filename: string): Promise<number> {
  const text = await readFile(filename, "utf8");
  return text.trim().split("\n").filter(Boolean).length;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("condition did not become true before timeout");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function restoreEnvironmentValue(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
