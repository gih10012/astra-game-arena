import { existsSync } from "node:fs";
import { lstat, readFile, readdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { durableJsonWrite } from "./run-checkpoint.js";
import type { AccountPolicy } from "./run-checkpoint.js";

export const ACCOUNT_POOL_FILENAME = "account-pool.json";
export interface CodexAccountProfile {
  id: string;
  email: string;
  home: string;
}

export interface RateWindowState {
  usedPercent: number | null;
  resetsAtMs: number | null;
}

export interface AccountUsageState extends CodexAccountProfile {
  reserveFiveHourPercent: number;
  reserveWeeklyPercent: number;
  primary: RateWindowState;
  secondary: RateWindowState;
  blockedUntilMs: number | null;
  lastPrimaryResetAtMs: number | null;
  updatedAt: string | null;
}

export interface AccountPoolState {
  version: 1;
  activeAccountId: string | null;
  accounts: AccountUsageState[];
}

export interface AccountChoice {
  account: AccountUsageState | null;
  limitedByReserve: boolean;
  retryAtMs: number | null;
}

export interface CodexRateLimits {
  primary: RateWindowState;
  secondary: RateWindowState;
}

export async function discoverCodexAccounts(
  root = process.env.ASTRA_CODEX_ACCOUNTS_ROOT ??
    defaultAccountsRoot(),
): Promise<CodexAccountProfile[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const profiles: CodexAccountProfile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const home = path.join(root, entry.name);
    try {
      const auth = JSON.parse(await readFile(path.join(home, "auth.json"), "utf8")) as {
        tokens?: { id_token?: string; account_id?: string };
      };
      const email = jwtEmail(auth.tokens?.id_token);
      if (!email || !auth.tokens?.account_id) continue;
      profiles.push({ id: auth.tokens.account_id, email, home });
    } catch {
      // An incomplete login directory is not an available account.
    }
  }
  return profiles.sort((left, right) => left.email.localeCompare(right.email));
}

function defaultAccountsRoot(): string {
  const generic = path.join(os.homedir(), ".codex-game-arena-accounts");
  const legacy = path.join(os.homedir(), ".codex-parabox-accounts");
  return existsSync(generic) ? generic : legacy;
}

export async function inheritCodexConfiguration(
  profileHome: string,
  sourceHome: string | undefined,
): Promise<void> {
  if (!sourceHome || path.resolve(profileHome) === path.resolve(sourceHome)) return;
  for (const name of [
    "config.toml",
    "skills",
    "plugins",
    "memories",
    "rules",
    "secrets",
  ]) {
    const source = path.join(sourceHome, name);
    const destination = path.join(profileHome, name);
    try {
      await lstat(destination);
      continue;
    } catch {
      // Create only missing shared configuration entries.
    }
    try {
      await lstat(source);
      await symlink(source, destination);
    } catch {
      // Optional Codex configuration is allowed to be absent.
    }
  }
}

export class AccountPool {
  readonly filename: string;
  #state: AccountPoolState;
  #writes: Promise<void> = Promise.resolve();

  private constructor(filename: string, state: AccountPoolState) {
    this.filename = filename;
    this.#state = state;
  }

  static async open(
    runDirectory: string,
    profiles: CodexAccountProfile[],
    policies: AccountPolicy[] = [],
  ): Promise<AccountPool> {
    const filename = path.join(runDirectory, ACCOUNT_POOL_FILENAME);
    let persisted: AccountPoolState | null = null;
    try {
      persisted = JSON.parse(await readFile(filename, "utf8")) as AccountPoolState;
    } catch {
      // Start a fresh telemetry file for this run.
    }
    const prior = new Map(
      (persisted?.version === 1 ? persisted.accounts : []).map((account) => [
        account.id,
        account,
      ]),
    );
    const configured = new Map(policies.map((policy) => [policy.accountId, policy]));
    const accounts = profiles
      .filter((profile) => configured.get(profile.id)?.enabled !== false)
      .map((profile) => {
        const old = prior.get(profile.id);
        const policy = configured.get(profile.id);
        return {
          ...profile,
          reserveFiveHourPercent: boundedPercent(
            policy?.reserveFiveHourPercent ?? old?.reserveFiveHourPercent ?? 0,
          ),
          reserveWeeklyPercent: boundedPercent(
            policy?.reserveWeeklyPercent ?? old?.reserveWeeklyPercent ?? 0,
          ),
          primary: old?.primary ?? unknownWindow(),
          secondary: old?.secondary ?? unknownWindow(),
          blockedUntilMs: old?.blockedUntilMs ?? null,
          lastPrimaryResetAtMs: old?.lastPrimaryResetAtMs ?? null,
          updatedAt: old?.updatedAt ?? null,
        };
      });
    const pool = new AccountPool(filename, {
      version: 1,
      activeAccountId: persisted?.activeAccountId ?? null,
      accounts,
    });
    await pool.persist();
    return pool;
  }

  snapshot(nowMs = Date.now()): AccountPoolState {
    this.#normalize(nowMs);
    return structuredClone(this.#state);
  }

  choose(nowMs = Date.now()): AccountChoice {
    this.#normalize(nowMs);
    const accounts = this.#state.accounts;
    const available = accounts.filter((account) => isAvailable(account, nowMs));
    const candidates = available.filter((candidate) => !reachedReserve(candidate));
    const account = [...candidates].sort((left, right) =>
      compareAccounts(left, right, this.#state.activeAccountId),
    )[0] ?? null;
    if (account) {
      this.#state.activeAccountId = account.id;
      return {
        account: structuredClone(account),
        limitedByReserve: available.some((candidate) => reachedReserve(candidate)),
        retryAtMs: null,
      };
    }
    return {
      account: null,
      limitedByReserve: available.some((candidate) => reachedReserve(candidate)),
      retryAtMs: nextEligibility(accounts, nowMs),
    };
  }

  async update(accountId: string, limits: CodexRateLimits): Promise<void> {
    const account = this.#state.accounts.find((entry) => entry.id === accountId);
    if (!account) return;
    if (
      account.primary.usedPercent !== null &&
      limits.primary.usedPercent !== null &&
      limits.primary.usedPercent < account.primary.usedPercent
    ) {
      account.lastPrimaryResetAtMs = Date.now();
    }
    account.primary = limits.primary;
    account.secondary = limits.secondary;
    account.blockedUntilMs = null;
    account.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async markBlocked(accountId: string, untilMs: number | null): Promise<void> {
    const account = this.#state.accounts.find((entry) => entry.id === accountId);
    if (!account) return;
    account.blockedUntilMs = untilMs;
    account.updatedAt = new Date().toISOString();
    await this.persist();
  }

  shouldStopForReserve(accountId: string, nowMs = Date.now()): boolean {
    this.#normalize(nowMs);
    const active = this.#state.accounts.find((entry) => entry.id === accountId);
    return active ? reachedReserve(active) : false;
  }

  hasImmediateAlternative(accountId: string, nowMs = Date.now()): boolean {
    const active = this.#state.activeAccountId;
    this.#state.activeAccountId = null;
    const choice = this.choose(nowMs);
    this.#state.activeAccountId = active;
    return choice.account !== null && choice.account.id !== accountId;
  }

  async persist(): Promise<void> {
    const snapshot = structuredClone(this.#state);
    this.#writes = this.#writes
      .catch(() => undefined)
      .then(() => durableJsonWrite(this.filename, snapshot));
    await this.#writes;
  }

  #normalize(nowMs: number): void {
    for (const account of this.#state.accounts) {
      if (
        account.primary.resetsAtMs !== null &&
        account.primary.resetsAtMs <= nowMs
      ) {
        account.lastPrimaryResetAtMs = account.primary.resetsAtMs;
        account.primary = { usedPercent: 0, resetsAtMs: null };
      }
      if (
        account.secondary.resetsAtMs !== null &&
        account.secondary.resetsAtMs <= nowMs
      ) {
        account.secondary = { usedPercent: 0, resetsAtMs: null };
      }
      if (account.blockedUntilMs !== null && account.blockedUntilMs <= nowMs) {
        account.lastPrimaryResetAtMs = Math.max(
          account.lastPrimaryResetAtMs ?? 0,
          account.blockedUntilMs,
        );
        account.blockedUntilMs = null;
      }
    }
  }
}

function unknownWindow(): RateWindowState {
  return { usedPercent: null, resetsAtMs: null };
}

function isAvailable(account: AccountUsageState, nowMs: number): boolean {
  if (account.blockedUntilMs !== null && account.blockedUntilMs > nowMs) return false;
  if (account.primary.usedPercent !== null && account.primary.usedPercent >= 100) {
    return false;
  }
  return account.secondary.usedPercent === null || account.secondary.usedPercent < 100;
}

function reachedReserve(account: AccountUsageState): boolean {
  const primaryLimit = 100 - account.reserveFiveHourPercent;
  const secondaryLimit = 100 - account.reserveWeeklyPercent;
  return (
    account.primary.usedPercent !== null && account.primary.usedPercent >= primaryLimit
  ) || (
    account.secondary.usedPercent !== null && account.secondary.usedPercent >= secondaryLimit
  );
}

function boundedPercent(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function compareAccounts(
  left: AccountUsageState,
  right: AccountUsageState,
  activeAccountId: string | null,
): number {
  const resetDifference =
    (right.lastPrimaryResetAtMs ?? Number.NEGATIVE_INFINITY) -
    (left.lastPrimaryResetAtMs ?? Number.NEGATIVE_INFINITY);
  if (resetDifference !== 0) return resetDifference;
  const activeDifference =
    Number(right.id === activeAccountId) - Number(left.id === activeAccountId);
  if (activeDifference !== 0) return activeDifference;
  return (left.primary.usedPercent ?? 0) - (right.primary.usedPercent ?? 0);
}

function nextEligibility(accounts: AccountUsageState[], nowMs: number): number | null {
  const accountDeadlines = accounts.flatMap((account) => {
    const blockers: Array<number | null> = [];
    if (account.blockedUntilMs !== null && account.blockedUntilMs > nowMs) {
      blockers.push(account.blockedUntilMs);
    }
    if (
      account.primary.usedPercent !== null &&
      account.primary.usedPercent >= 100 - account.reserveFiveHourPercent
    ) {
      blockers.push(account.primary.resetsAtMs);
    }
    if (
      account.secondary.usedPercent !== null &&
      account.secondary.usedPercent >= 100 - account.reserveWeeklyPercent
    ) {
      blockers.push(account.secondary.resetsAtMs);
    }
    if (blockers.length === 0 || blockers.some((deadline) => deadline === null)) return [];
    return [Math.max(...blockers as number[])];
  });
  return accountDeadlines.length > 0 ? Math.min(...accountDeadlines) : null;
}

function jwtEmail(token: string | undefined): string | null {
  if (!token) return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: unknown;
    };
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}
