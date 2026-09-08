import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { LevelProgress, TokenUsage } from "./types.js";
import type { InstalledSteamGame } from "./steam-catalog.js";

export const CHECKPOINT_FILENAME = "checkpoint.json";

export type RunPhase =
  | "starting"
  | "running"
  | "waiting_quota"
  | "waiting_power"
  | "waiting_retry"
  | "paused"
  | "completed"
  | "failed";

export interface PersistedRunOptions {
  rootDirectory: string;
  publicPort?: number;
  port: number;
  model?: string;
  goal?: string;
  game?: InstalledSteamGame;
  gpuPreference: "auto" | "integrated" | "discrete";
  launchMode?: "steam-online" | "steam-offline" | "direct";
  offlineMode?: boolean;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  record: boolean;
  virtualCamera: boolean;
  virtualCameraDevice: string;
  openDashboard: boolean;
  isolateSaves: boolean;
  codexHome?: string;
  quotaWaitMs: number;
  accountPolicies?: AccountPolicy[];
  webSearchEnabled?: boolean;
  browserUseEnabled?: boolean;
  toolCreationGuidance?: boolean;
}

export interface AccountPolicy {
  accountId: string;
  enabled: boolean;
  reserveFiveHourPercent: number;
  reserveWeeklyPercent: number;
}

export interface RecordingPair {
  attempt: number;
  game: string;
  dashboard: string;
}

export interface CodexCredentialState {
  mode: "chatgpt-pool" | "api-key";
  provider: string;
  label: string;
}

export interface RunCheckpoint {
  version: 1;
  runId: string;
  runDirectory: string;
  createdAt: string;
  updatedAt: string;
  phase: RunPhase;
  attempt: number;
  pid: number | null;
  pidStartTicks: string | null;
  threadId: string | null;
  retryAt: string | null;
  reason: string | null;
  savePrepared: boolean;
  elapsedMs: number;
  startedAt: string | null;
  tokens: TokenUsage;
  tokenCursor?: TokenUsage | null;
  progress: LevelProgress;
  recordings: string[];
  recordingPairs?: RecordingPair[];
  credential?: CodexCredentialState | null;
  options: PersistedRunOptions;
}

interface ActiveRunPointer {
  version: 1;
  runDirectory: string;
  updatedAt: string;
}

export class CheckpointStore {
  readonly filename: string;
  #value: RunCheckpoint;
  #writes: Promise<void> = Promise.resolve();

  constructor(filename: string, value: RunCheckpoint) {
    this.filename = filename;
    this.#value = {
      ...value,
      credential: normalizeCodexCredential(value.credential),
    };
  }

  static async load(runDirectory: string): Promise<CheckpointStore> {
    const resolvedRunDirectory = path.resolve(runDirectory);
    const filename = path.join(resolvedRunDirectory, CHECKPOINT_FILENAME);
    const value = JSON.parse(await readFile(filename, "utf8")) as RunCheckpoint;
    if (value.version !== 1) {
      throw new Error(`Invalid run checkpoint: ${filename}`);
    }
    const relocated = value.runDirectory !== resolvedRunDirectory;
    if (relocated) {
      const relocatedRoot = path.resolve(resolvedRunDirectory, "../..");
      const oldRelative = path.relative(
        value.options.rootDirectory,
        value.runDirectory,
      );
      const newRelative = path.relative(relocatedRoot, resolvedRunDirectory);
      if (oldRelative !== newRelative || !newRelative.startsWith(`runs${path.sep}`)) {
        throw new Error(`Invalid run checkpoint: ${filename}`);
      }
      value.runDirectory = resolvedRunDirectory;
      value.options.rootDirectory = relocatedRoot;
    }
    value.options.virtualCamera ??= false;
    value.options.virtualCameraDevice ??= "/dev/video10";
    value.options.gpuPreference ??= "auto";
    value.options.offlineMode ??= false;
    const store = new CheckpointStore(filename, value);
    if (relocated) await store.update({});
    return store;
  }

  snapshot(): RunCheckpoint {
    return structuredClone(this.#value);
  }

  async update(
    patch:
      | Partial<RunCheckpoint>
      | ((current: RunCheckpoint) => Partial<RunCheckpoint>),
  ): Promise<RunCheckpoint> {
    const delta = typeof patch === "function" ? patch(this.snapshot()) : patch;
    this.#value = {
      ...this.#value,
      ...delta,
      updatedAt: new Date().toISOString(),
    };
    const snapshot = this.snapshot();
    this.#writes = this.#writes
      .catch(() => undefined)
      .then(() => durableJsonWrite(this.filename, snapshot));
    await this.#writes;
    return snapshot;
  }

  async flush(): Promise<void> {
    await this.#writes;
  }
}

export function checkpointPath(runDirectory: string): string {
  return path.join(path.resolve(runDirectory), CHECKPOINT_FILENAME);
}

export function normalizeCodexCredential(
  value: unknown,
): CodexCredentialState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultChatGptCredential();
  }
  const credential = value as Record<string, unknown>;
  if (
    credential.mode === "api-key" &&
    typeof credential.provider === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(credential.provider) &&
    typeof credential.label === "string" &&
    credential.label.length > 0 &&
    credential.label.length <= 120
  ) {
    return {
      mode: "api-key",
      provider: credential.provider,
      label: credential.label,
    };
  }
  return defaultChatGptCredential();
}

function defaultChatGptCredential(): CodexCredentialState {
  return {
    mode: "chatgpt-pool",
    provider: "openai",
    label: "ChatGPT account pool",
  };
}

export function activeRunPath(rootDirectory: string): string {
  return path.join(path.resolve(rootDirectory), ".arena", "active-run.json");
}

export async function readActiveRun(
  rootDirectory: string,
): Promise<string | null> {
  try {
    const pointer = JSON.parse(
      await readFile(activeRunPath(rootDirectory), "utf8"),
    ) as ActiveRunPointer;
    if (pointer.version !== 1) return null;
    const original = path.resolve(pointer.runDirectory);
    try {
      await readFile(path.join(original, CHECKPOINT_FILENAME));
      return original;
    } catch {
      const relocated = path.join(
        path.resolve(rootDirectory),
        "runs",
        path.basename(original),
      );
      try {
        await readFile(path.join(relocated, CHECKPOINT_FILENAME));
        return relocated;
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }
}

export async function registerActiveRun(
  rootDirectory: string,
  runDirectory: string,
): Promise<void> {
  const current = await readActiveRun(rootDirectory);
  if (current && current !== path.resolve(runDirectory)) {
    try {
      const checkpoint = await CheckpointStore.load(current);
      if (!isTerminal(checkpoint.snapshot().phase)) {
        throw new Error(`Another challenge is active: ${current}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Another challenge")) {
        throw error;
      }
    }
  }
  await durableJsonWrite(activeRunPath(rootDirectory), {
    version: 1,
    runDirectory: path.resolve(runDirectory),
    updatedAt: new Date().toISOString(),
  } satisfies ActiveRunPointer);
}

export async function clearActiveRun(
  rootDirectory: string,
  runDirectory: string,
): Promise<void> {
  const current = await readActiveRun(rootDirectory);
  if (current === path.resolve(runDirectory)) {
    await rm(activeRunPath(rootDirectory), { force: true });
  }
}

export function isTerminal(phase: RunPhase): boolean {
  return phase === "completed" || phase === "failed";
}

export function processStartTicks(pid = process.pid): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParenthesis = stat.lastIndexOf(")");
    if (closingParenthesis < 0) return null;
    const fieldsFromState = stat.slice(closingParenthesis + 2).trim().split(/\s+/);
    return fieldsFromState[19] ?? null;
  } catch {
    return null;
  }
}

export function processMatches(
  pid: number,
  expectedStartTicks: string | null | undefined,
): boolean {
  const actualStartTicks = processStartTicks(pid);
  if (actualStartTicks === null) return false;
  return expectedStartTicks ? actualStartTicks === expectedStartTicks : true;
}

export async function durableJsonWrite(
  filename: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filename);
  try {
    const directory = await open(path.dirname(filename), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Some filesystems do not support syncing a directory handle.
  }
}
