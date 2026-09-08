import { constants } from "node:fs";
import { access, chmod, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const BACKUP_SUFFIX = ".astra-game-arena-backup";

export interface SteamLoginModeLease {
  loginUsersPath: string;
  restore(): Promise<void>;
}

export class SteamLoginStateUnavailableError extends Error {
  override name = "SteamLoginStateUnavailableError";
}

export function steamOfflineLoginConfig(source: string): string {
  return steamLoginConfig(source, true);
}

export function steamLoginConfig(source: string, offline: boolean): string {
  let wantsOffline = 0;
  let skipsWarning = 0;
  const value = offline ? "1" : "0";
  const updated = source
    .replace(/("WantsOfflineMode"\s*)"[^"]*"/g, (_match, prefix: string) => {
      wantsOffline += 1;
      return `${prefix}"${value}"`;
    })
    .replace(/("SkipOfflineModeWarning"\s*)"[^"]*"/g, (_match, prefix: string) => {
      skipsWarning += 1;
      return `${prefix}"${value}"`;
    });
  if (wantsOffline === 0 || skipsWarning === 0) {
    throw new SteamLoginStateUnavailableError(
      "Steam has no cached offline-login state. Sign in once and enable Remember me before using Steam Offline mode.",
    );
  }
  return updated;
}

export async function prepareSteamOfflineLogin(steamRoot: string): Promise<SteamLoginModeLease> {
  return await prepareSteamLoginMode(steamRoot, true);
}

export async function prepareSteamLoginMode(
  steamRoot: string,
  offline: boolean,
): Promise<SteamLoginModeLease> {
  const loginUsersPath = path.join(steamRoot, "config", "loginusers.vdf");
  const backupPath = `${loginUsersPath}${BACKUP_SUFFIX}`;

  if (await exists(backupPath)) {
    await restoreBackup(loginUsersPath, backupPath);
  }
  const original = await readFile(loginUsersPath, "utf8");
  const patched = steamLoginConfig(original, offline);
  const mode = (await stat(loginUsersPath)).mode & 0o777;
  await writePrivateFile(backupPath, original, mode);
  try {
    await writePrivateFile(loginUsersPath, patched, mode);
  } catch (error) {
    try {
      await restoreBackup(loginUsersPath, backupPath);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "Steam login mode could not be changed or restored",
        { cause: error },
      );
    }
    throw error;
  }

  let restored = false;
  return {
    loginUsersPath,
    restore: async () => {
      if (restored) return;
      await restoreBackup(loginUsersPath, backupPath);
      restored = true;
    },
  };
}

async function restoreBackup(loginUsersPath: string, backupPath: string): Promise<void> {
  if (!(await exists(backupPath))) return;
  const mode = (await stat(backupPath)).mode & 0o777;
  const original = await readFile(backupPath, "utf8");
  await writePrivateFile(loginUsersPath, original, mode);
  await rm(backupPath, { force: true });
}

async function writePrivateFile(filename: string, content: string, mode: number): Promise<void> {
  const temporary = `${filename}.tmp-${process.pid}`;
  await writeFile(temporary, content, { mode: 0o600 });
  await chmod(temporary, mode);
  await rename(temporary, filename);
}

async function exists(filename: string): Promise<boolean> {
  return await access(filename, constants.F_OK).then(() => true).catch(() => false);
}
