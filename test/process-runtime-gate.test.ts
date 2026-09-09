import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  createProcessRuntimeGate,
  markedProcessIds,
} from "../src/process-runtime-gate.js";

test("freezes and thaws only processes carrying the private game marker", async (context) => {
  const gate = createProcessRuntimeGate(`test-${process.pid}-${Date.now()}`);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env: { ...process.env, ...gate.environment },
    stdio: "ignore",
  });
  context.after(async () => {
    await gate.thaw().catch(() => undefined);
    child.kill("SIGKILL");
  });
  assert.ok(child.pid);

  await waitFor(async () => (await markedProcessIds(
    String(gate.environment.ASTRA_GAME_RUNTIME_ID),
  )).includes(child.pid!));
  assert.deepEqual(await gate.freeze(), [child.pid]);
  assert.equal(gate.frozen, true);
  assert.match(await processState(child.pid), /^[Tt]$/);
  assert.deepEqual(await gate.thaw(), [child.pid]);
  assert.equal(gate.frozen, false);
  await waitFor(async () => !/^[Tt]$/.test(await processState(child.pid!)));
});

async function processState(pid: number): Promise<string> {
  const status = await import("node:fs/promises").then(({ readFile }) =>
    readFile(`/proc/${pid}/status`, "utf8")
  );
  return /^State:\s+(\S)/m.exec(status)?.[1] ?? "";
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for process state");
}
