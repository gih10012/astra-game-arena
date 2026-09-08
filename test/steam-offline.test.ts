import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  prepareSteamOfflineLogin,
  prepareSteamLoginMode,
  SteamLoginStateUnavailableError,
  steamLoginConfig,
  steamOfflineLoginConfig,
} from "../src/steam-offline.js";

const loginUsers = `"users"
{
  "76561190000000000"
  {
    "AccountName" "example"
    "MostRecent" "1"
    "WantsOfflineMode" "0"
    "SkipOfflineModeWarning" "0"
  }
}`;

test("enables cached Steam offline login without changing other values", () => {
  const updated = steamOfflineLoginConfig(loginUsers);
  assert.match(updated, /"WantsOfflineMode"\s+"1"/);
  assert.match(updated, /"SkipOfflineModeWarning"\s+"1"/);
  assert.match(updated, /"AccountName" "example"/);
});

test("can explicitly restore online login flags for an online launch", () => {
  const offline = steamOfflineLoginConfig(loginUsers);
  const online = steamLoginConfig(offline, false);
  assert.match(online, /"WantsOfflineMode"\s+"0"/);
  assert.match(online, /"SkipOfflineModeWarning"\s+"0"/);
});

test("rejects a Steam profile that has no cached offline state", () => {
  assert.throws(
    () => steamOfflineLoginConfig('"users"\n{\n}'),
    (error: unknown) =>
      error instanceof SteamLoginStateUnavailableError &&
      /no cached offline-login state/i.test(error.message),
  );
});

test("does not classify Steam configuration I/O failures as optional login state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-steam-io-error-"));
  await assert.rejects(
    prepareSteamLoginMode(root, false),
    (error: unknown) => !(error instanceof SteamLoginStateUnavailableError),
  );
});

test("restores loginusers exactly and recovers a stale backup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-steam-offline-"));
  const config = path.join(root, "config");
  const filename = path.join(config, "loginusers.vdf");
  await mkdir(config, { recursive: true });
  await writeFile(filename, loginUsers, { mode: 0o600 });

  const first = await prepareSteamOfflineLogin(root);
  assert.match(await readFile(filename, "utf8"), /"WantsOfflineMode"\s+"1"/);
  const second = await prepareSteamOfflineLogin(root);
  await second.restore();
  assert.equal(await readFile(filename, "utf8"), loginUsers);
  await first.restore();
  assert.equal(await readFile(filename, "utf8"), loginUsers);
});

test("can retry a failed Steam login lease restore", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-steam-restore-retry-"));
  const config = path.join(root, "config");
  const filename = path.join(config, "loginusers.vdf");
  const blockedTemporary = `${filename}.tmp-${process.pid}`;
  await mkdir(config, { recursive: true });
  await writeFile(filename, loginUsers, { mode: 0o600 });

  const lease = await prepareSteamOfflineLogin(root);
  await mkdir(blockedTemporary);
  await assert.rejects(lease.restore());
  await rm(blockedTemporary, { recursive: true });

  await lease.restore();
  assert.equal(await readFile(filename, "utf8"), loginUsers);
});
