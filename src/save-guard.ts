import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { durableJsonWrite } from "./run-checkpoint.js";

interface RecoveryEntry {
  original: string;
  backup: string;
}

interface RecoveryPlan {
  createdAt: string;
  saveDirectory: string;
  entries: RecoveryEntry[];
  restoreStartedAt?: string;
  restoredAt?: string;
}

export class SaveGuard {
  readonly saveDirectory: string;
  readonly runDirectory: string;
  readonly recoveryPath: string;
  #plan: RecoveryPlan | null = null;

  constructor(saveDirectory: string, runDirectory: string) {
    this.saveDirectory = saveDirectory;
    this.runDirectory = runDirectory;
    this.recoveryPath = path.join(runDirectory, "save-recovery.json");
  }

  async prepare(): Promise<void> {
    await stat(this.saveDirectory);
    try {
      await this.load();
    } catch {
      // A new run has no recovery plan yet.
    }
    if (this.#plan) {
      for (const entry of this.#plan.entries) {
        if (await exists(entry.backup)) continue;
        if (await exists(entry.original)) await rename(entry.original, entry.backup);
      }
      return;
    }
    const backupDirectory = path.join(this.runDirectory, "save-backup");
    await mkdir(backupDirectory, { recursive: true });
    const names = (await readdir(this.saveDirectory)).filter((name) =>
      /^save\d+\.txt$/i.test(name),
    );
    const entries = names.map((name) => ({
      original: path.join(this.saveDirectory, name),
      backup: path.join(backupDirectory, name),
    }));
    this.#plan = {
      createdAt: new Date().toISOString(),
      saveDirectory: this.saveDirectory,
      entries,
    };
    await this.#writePlan();
    for (const entry of entries) await rename(entry.original, entry.backup);
  }

  async load(): Promise<void> {
    this.#plan = JSON.parse(await readFile(this.recoveryPath, "utf8")) as RecoveryPlan;
  }

  async resume(): Promise<void> {
    await this.load();
    const liveNames = await saveNames(this.saveDirectory);
    if (
      liveNames.length > 0 &&
      !this.#plan?.restoredAt &&
      !this.#plan?.restoreStartedAt
    ) {
      return;
    }

    const candidates = [
      path.join(this.runDirectory, "checkpoint-save"),
      path.join(this.runDirectory, "challenge-save"),
    ];
    const source = await firstSaveDirectory(candidates);
    if (!source) return;
    for (const name of await saveNames(source)) {
      await copyAtomic(
        path.join(source, name),
        path.join(this.saveDirectory, name),
      );
    }
    if (this.#plan?.restoredAt) {
      delete this.#plan.restoredAt;
    }
    if (this.#plan?.restoreStartedAt) delete this.#plan.restoreStartedAt;
    await this.#writePlan();
  }

  async seedFrom(sourceDirectory: string): Promise<void> {
    if (!this.#plan) {
      throw new Error("Save isolation must be prepared before seeding a challenge save");
    }
    const names = await saveNames(sourceDirectory);
    if (names.length === 0) {
      throw new Error(`No challenge save files found in ${sourceDirectory}`);
    }
    for (const name of names) {
      await copyAtomic(
        path.join(sourceDirectory, name),
        path.join(this.saveDirectory, name),
      );
    }
  }

  async checkpointChallenge(): Promise<void> {
    const checkpointDirectory = path.join(this.runDirectory, "checkpoint-save");
    await mkdir(checkpointDirectory, { recursive: true });
    for (const name of await saveNames(this.saveDirectory)) {
      await copyAtomic(
        path.join(this.saveDirectory, name),
        path.join(checkpointDirectory, name),
      );
    }
  }

  async restore(): Promise<void> {
    if (!this.#plan) return;
    await this.checkpointChallenge();
    this.#plan.restoreStartedAt = new Date().toISOString();
    await this.#writePlan();
    const challengeDirectory = path.join(this.runDirectory, "challenge-save");
    await mkdir(challengeDirectory, { recursive: true });
    for (const name of await saveNames(this.saveDirectory)) {
      await copyAtomic(
        path.join(this.saveDirectory, name),
        path.join(challengeDirectory, name),
      );
      await rm(path.join(this.saveDirectory, name), { force: true });
    }
    for (const entry of this.#plan.entries) {
      await copyFile(entry.backup, entry.original);
    }
    this.#plan.restoredAt = new Date().toISOString();
    delete this.#plan.restoreStartedAt;
    await this.#writePlan();
  }

  async #writePlan(): Promise<void> {
    if (!this.#plan) return;
    await durableJsonWrite(this.recoveryPath, this.#plan);
  }
}

export async function restoreFromRecovery(recoveryPath: string): Promise<void> {
  const plan = JSON.parse(
    await readFile(recoveryPath, "utf8"),
  ) as RecoveryPlan;
  const challengeDirectory = path.join(path.dirname(recoveryPath), "challenge-save");
  plan.restoreStartedAt = new Date().toISOString();
  await durableJsonWrite(recoveryPath, plan);
  await mkdir(challengeDirectory, { recursive: true });
  for (const name of await saveNames(plan.saveDirectory)) {
    await copyAtomic(
      path.join(plan.saveDirectory, name),
      path.join(challengeDirectory, name),
    );
    await rm(path.join(plan.saveDirectory, name), { force: true });
  }
  for (const entry of plan.entries) {
    await copyFile(entry.backup, entry.original);
  }
  plan.restoredAt = new Date().toISOString();
  delete plan.restoreStartedAt;
  await durableJsonWrite(recoveryPath, plan);
}

async function saveNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter((name) =>
      /^save\d+\.txt$/i.test(name),
    );
  } catch {
    return [];
  }
}

async function firstSaveDirectory(
  directories: string[],
): Promise<string | null> {
  for (const directory of directories) {
    if ((await saveNames(directory)).length > 0) return directory;
  }
  return null;
}

async function exists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch {
    return false;
  }
}

async function copyAtomic(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await copyFile(source, temporary);
  const handle = await open(temporary, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  try {
    const directory = await open(path.dirname(destination), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Some filesystems do not support syncing a directory handle.
  }
}
