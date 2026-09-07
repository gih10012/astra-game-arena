import { lstat, readFile, readdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { durableJsonWrite } from "./run-checkpoint.js";

export const ACCOUNT_POOL_FILENAME = "account-pool.json";
export const RESERVE_USED_PERCENT = 50;

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
  primary: RateWindowState;
  secondary: RateWindowState;
  blockedUntilMs: number | null;
  lastPrimaryResetAtMs: number | null;
  updatedAt: string | null;
}

export interface AccountPoolState {
  version: 1;
  reserveUsedPercent: number;
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
    path.join(os.homedir(), ".codex-parabox-accounts"),
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
    const accounts = profiles.map((profile) => ({
      ...profile,
      primary: prior.get(profile.id)?.primary ?? unknownWindow(),
      secondary: prior.get(profile.id)?.secondary ?? unknownWindow(),
      blockedUntilMs: prior.get(profile.id)?.blockedUntilMs ?? null,
      lastPrimaryResetAtMs: prior.get(profile.id)?.lastPrimaryResetAtMs ?? null,
      updatedAt: prior.get(profile.id)?.updatedAt ?? null,
    }));
    const pool = new AccountPool(filename, {
      version: 1,
      reserveUsedPercent: RESERVE_USED_PERCENT,
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
    const candidates = available.filter((candidate) => {
      const anotherAccountIsReserved = accounts.some(
        (other) =>
          other.id !== candidate.id &&
          other.primary.usedPercent !== null &&
          other.primary.usedPercent <= this.#state.reserveUsedPercent,
      );
      return anotherAccountIsReserved ||
        candidate.primary.usedPercent === null ||
        candidate.primary.usedPercent < this.#state.reserveUsedPercent;
    });
    const account = [...candidates].sort((left, right) =>
      compareAccounts(left, right, this.#state.activeAccountId),
    )[0] ?? null;
    if (account) {
      this.#state.activeAccountId = account.id;
      return {
        account: structuredClone(account),
        limitedByReserve: !accounts.some(
          (other) =>
            other.id !== account.id &&
            other.primary.usedPercent !== null &&
            other.primary.usedPercent <= this.#state.reserveUsedPercent,
        ),
        retryAtMs: null,
      };
    }
    return {
      account: null,
      limitedByReserve: false,
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
    if (
      !active ||
      active.primary.usedPercent === null ||
      active.primary.usedPercent < this.#state.reserveUsedPercent
    ) {
      return false;
    }
    return !this.#state.accounts.some(
      (other) =>
        other.id !== accountId &&
        other.primary.usedPercent !== null &&
        other.primary.usedPercent <= this.#state.reserveUsedPercent,
    );
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
  const deadlines = accounts.flatMap((account) => [
    account.blockedUntilMs,
    account.primary.resetsAtMs,
    account.secondary.resetsAtMs,
  ]).filter((deadline): deadline is number => deadline !== null && deadline > nowMs);
  return deadlines.length > 0 ? Math.min(...deadlines) : null;
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
