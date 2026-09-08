import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readRuntimeConfigAck,
  readRuntimeConfigRequest,
  readRuntimeMediaState,
  writeRuntimeConfigAck,
  writeRuntimeConfigRequest,
  writeRuntimeMediaState,
} from "../src/runtime-config.js";

test("queues runtime configuration requests without overwriting concurrent writers", async () => {
  const runDirectory = await mkdtemp(path.join(os.tmpdir(), "game-arena-runtime-config-"));
  await Promise.all([
    writeRuntimeConfigRequest(runDirectory, {
      version: 1,
      id: "request-a",
      requestedAt: "2026-09-08T00:00:00.000Z",
      patch: { record: false },
    }),
    writeRuntimeConfigRequest(runDirectory, {
      version: 1,
      id: "request-b",
      requestedAt: "2026-09-08T00:00:01.000Z",
      patch: { reasoningEffort: "xhigh" },
    }),
  ]);

  assert.equal((await readRuntimeConfigRequest(runDirectory))?.id, "request-a");
  await writeRuntimeConfigAck(runDirectory, {
    version: 1,
    id: "request-a",
    appliedAt: "2026-09-08T00:00:02.000Z",
    appliedFields: ["record"],
    deferredFields: [],
    codexRestarted: false,
    error: null,
  });
  assert.equal((await readRuntimeConfigRequest(runDirectory))?.id, "request-b");
  assert.equal((await readRuntimeConfigAck(runDirectory, "request-a"))?.id, "request-a");
  assert.equal(await readRuntimeConfigAck(runDirectory, "request-b"), null);
});

test("persists actual runtime media state", async () => {
  const runDirectory = await mkdtemp(path.join(os.tmpdir(), "game-arena-media-state-"));
  const state = {
    version: 1 as const,
    updatedAt: "2026-09-08T00:00:00.000Z",
    recordingActive: true,
    recordingError: null,
    virtualCameraActive: false,
    virtualCameraDevice: null,
    virtualCameraError: "camera stopped",
  };
  await writeRuntimeMediaState(runDirectory, state);
  assert.deepEqual(await readRuntimeMediaState(runDirectory), state);
});
