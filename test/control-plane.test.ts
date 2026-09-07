import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlPlane } from "../src/control-plane.js";

test("serves the durable control page with every pre-run setting", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "game-arena-control-"));
  const control = new ControlPlane(root, { port: 0 });
  const url = await control.listen();
  context.after(() => control.close());

  assert.deepEqual(await fetch(`${url}/health`).then((response) => response.json()), {
    ok: true,
    service: "astra-game-arena",
  });
  const html = await fetch(url).then((response) => response.text());
  for (const id of [
    "game-select",
    "goal-input",
    "record-toggle",
    "model-select",
    "reasoning-select",
    "account-pool",
    "start-button",
    "pause-button",
    "resume-button",
    "end-button",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});
