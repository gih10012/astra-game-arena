import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AccountPool,
  discoverCodexAccounts,
  type CodexAccountProfile,
} from "../src/account-pool.js";

function profile(id: string, email: string, home: string): CodexAccountProfile {
  return { id, email, home };
}

test("discovers isolated ChatGPT account homes without exposing tokens", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "parabox-accounts-"));
  const home = path.join(root, "account-a");
  await mkdir(home);
  const payload = Buffer.from(JSON.stringify({ email: "a@example.test" })).toString("base64url");
  await writeFile(
    path.join(home, "auth.json"),
    JSON.stringify({ tokens: { id_token: `x.${payload}.x`, account_id: "account-a" } }),
  );
  assert.deepEqual(await discoverCodexAccounts(root), [
    { id: "account-a", email: "a@example.test", home },
  ]);
});

test("rotates accounts while preserving half of one five-hour window", async () => {
  const run = await mkdtemp(path.join(os.tmpdir(), "parabox-pool-"));
  const now = new Date("2026-09-07T01:00:00Z").getTime();
  const pool = await AccountPool.open(run, [
    profile("a", "a@example.test", "/accounts/a"),
    profile("b", "b@example.test", "/accounts/b"),
  ]);
  assert.equal(pool.choose(now).account?.id, "a");
  await pool.update("a", {
    primary: { usedPercent: 50, resetsAtMs: now + 3_600_000 },
    secondary: { usedPercent: 10, resetsAtMs: now + 86_400_000 },
  });
  assert.equal(pool.shouldStopForReserve("a", now), true);
  assert.equal(pool.choose(now).account?.id, "b");
  await pool.update("b", {
    primary: { usedPercent: 70, resetsAtMs: now + 7_200_000 },
    secondary: { usedPercent: 10, resetsAtMs: now + 86_400_000 },
  });
  assert.equal(pool.shouldStopForReserve("b", now), false);
  assert.equal(pool.choose(now).account?.id, "b");
  assert.match(await readFile(path.join(run, "account-pool.json"), "utf8"), /"reserveUsedPercent": 50/);
});

test("prefers the account whose allowance most recently reset", async () => {
  const run = await mkdtemp(path.join(os.tmpdir(), "parabox-pool-reset-"));
  const now = new Date("2026-09-07T03:00:00Z").getTime();
  const pool = await AccountPool.open(run, [
    profile("a", "a@example.test", "/accounts/a"),
    profile("b", "b@example.test", "/accounts/b"),
  ]);
  await pool.update("a", {
    primary: { usedPercent: 60, resetsAtMs: now + 3_600_000 },
    secondary: { usedPercent: 10, resetsAtMs: now + 86_400_000 },
  });
  await pool.update("b", {
    primary: { usedPercent: 80, resetsAtMs: now - 1 },
    secondary: { usedPercent: 10, resetsAtMs: now + 86_400_000 },
  });
  assert.equal(pool.choose(now).account?.id, "b");
  assert.equal(pool.choose(now).limitedByReserve, true);
});
