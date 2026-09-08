import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RolloutTailer } from "../src/rollout-tailer.js";

test("follows the growing rollout when another account has a static copy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rollout-tailer-"));
  const staticRoot = path.join(root, "static");
  const liveRoot = path.join(root, "live");
  await Promise.all([
    mkdir(staticRoot, { recursive: true }),
    mkdir(liveRoot, { recursive: true }),
  ]);
  const threadId = "00000000-0000-0000-0000-000000000123";
  const name = `rollout-${threadId}.jsonl`;
  const oldLine = JSON.stringify({
    timestamp: "2020-01-01T00:00:00.000Z",
    type: "old",
  });
  await writeFile(path.join(liveRoot, name), `${oldLine}\n`);
  await writeFile(path.join(staticRoot, name), `${oldLine}\n`);

  const tailer = new RolloutTailer(
    threadId,
    [staticRoot, liveRoot],
    Date.now() - 1_000,
  );
  const received: unknown[] = [];
  const completed = new Promise<void>((resolve) => {
    void tailer.follow(async (event) => {
      received.push(event);
      tailer.stop();
      resolve();
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const liveLine = JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "token_usage_record",
  });
  await writeFile(path.join(liveRoot, name), `${oldLine}\n${liveLine}\n`);
  await Promise.race([
    completed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("tailer did not switch rollout files")), 3_000)
    ),
  ]);

  assert.deepEqual(received, [JSON.parse(liveLine)]);
});
