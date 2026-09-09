import assert from "node:assert/strict";
import test from "node:test";
import { runWorkerUnitName } from "../src/run-worker.js";

test("creates a stable safe unit name for an isolated challenge worker", () => {
  assert.equal(
    runWorkerUnitName("2026-09-09T00:12:34.567Z-ABC_123"),
    "astra-game-arena-runner-2026-09-09t00-12-34-567z-abc-123.service",
  );
});

test("rejects a run id without a usable systemd unit stem", () => {
  assert.throws(() => runWorkerUnitName("..."), /cannot be converted/);
});
