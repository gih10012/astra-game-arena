import type { TokenUsage } from "./types.js";
import type { CodexRateLimits, RateWindowState } from "./account-pool.js";

type JsonObject = Record<string, unknown>;

const zeroUsage = (): TokenUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
});

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function normalize(raw: JsonObject): TokenUsage {
  const inputTokens = nonNegative(raw.input_tokens ?? raw.inputTokens);
  const cachedInputTokens = nonNegative(
    raw.cached_input_tokens ?? raw.cachedInputTokens,
  );
  const outputTokens = nonNegative(raw.output_tokens ?? raw.outputTokens);
  const reasoningOutputTokens = nonNegative(
    raw.reasoning_output_tokens ?? raw.reasoningOutputTokens,
  );
  const reportedTotal = nonNegative(raw.total_tokens ?? raw.totalTokens);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: reportedTotal || inputTokens + outputTokens,
  };
}

export function extractTokenUsage(event: unknown): {
  usage: TokenUsage;
  source: "rollout" | "exec";
} | null {
  const root = object(event);
  if (!root) return null;

  if (root.type === "turn.completed") {
    const usage = object(root.usage);
    return usage ? { usage: normalize(usage), source: "exec" } : null;
  }

  if (root.type === "event_msg") {
    const payload = object(root.payload);
    if (payload?.type !== "token_count") return null;
    const info = object(payload.info);
    const total = object(info?.total_token_usage);
    return total ? { usage: normalize(total), source: "rollout" } : null;
  }

  return null;
}

export function extractQuotaResetAt(event: unknown): number | null {
  const root = object(event);
  const payload = object(root?.payload);
  const rateLimits = object(payload?.rate_limits ?? root?.rate_limits);
  if (!rateLimits) return null;

  const reachedType =
    typeof rateLimits.rate_limit_reached_type === "string"
      ? rateLimits.rate_limit_reached_type.toLowerCase()
      : "";
  const windows = ["primary", "secondary", "individual_limit"]
    .map((name) => {
      const window = object(rateLimits[name]);
      if (!window) return null;
      const resetsAt = nonNegative(window.resets_at ?? window.resetsAt);
      const usedPercent = nonNegative(
        window.used_percent ?? window.usedPercent,
      );
      return resetsAt > 0 ? { name, resetsAt, usedPercent } : null;
    })
    .filter((window) => window !== null);

  const explicitlyReached = windows.filter(({ name }) =>
    rateLimitTypeMatchesWindow(reachedType, name),
  );
  const exhausted = windows.filter(({ usedPercent }) => usedPercent >= 100);
  const applicable = [...explicitlyReached, ...exhausted];
  if (applicable.length === 0) return null;
  return Math.max(...applicable.map(({ resetsAt }) => resetsAt)) * 1_000;
}

export function extractRateLimits(event: unknown): CodexRateLimits | null {
  const root = object(event);
  const payload = object(root?.payload);
  const rateLimits = object(payload?.rate_limits ?? root?.rate_limits);
  if (!rateLimits) return null;
  const primary = rateWindow(rateLimits.primary);
  const secondary = rateWindow(rateLimits.secondary);
  return primary || secondary
    ? {
        primary: primary ?? { usedPercent: null, resetsAtMs: null },
        secondary: secondary ?? { usedPercent: null, resetsAtMs: null },
      }
    : null;
}

export function mergeUsage(current: TokenUsage, next: TokenUsage): TokenUsage {
  if (next.totalTokens >= current.totalTokens) return next;
  return current;
}

export function emptyTokenUsage(): TokenUsage {
  return zeroUsage();
}

function rateLimitTypeMatchesWindow(type: string, name: string): boolean {
  if (!type) return false;
  if (type.includes(name)) return true;
  if (name === "primary") return /(?:five|5)[_-]?(?:hour|h)/.test(type);
  if (name === "secondary") return type.includes("week");
  return name === "individual_limit" && type.includes("individual");
}

function rateWindow(value: unknown): RateWindowState | null {
  const window = object(value);
  if (!window) return null;
  const used = window.used_percent ?? window.usedPercent;
  const reset = window.resets_at ?? window.resetsAt;
  return {
    usedPercent:
      typeof used === "number" && Number.isFinite(used) ? used : null,
    resetsAtMs:
      typeof reset === "number" && Number.isFinite(reset) && reset > 0
        ? reset * 1_000
        : null,
  };
}

export function publicTranscriptEvent(event: unknown): unknown | null {
  const root = object(event);
  if (!root || typeof root.type !== "string") return null;
  return sanitizeTranscriptValue(root, null, 0);
}

function sanitizeTranscriptValue(
  value: unknown,
  key: string | null,
  depth: number,
): unknown {
  if (depth > 12) return "[nested value omitted]";
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (key && /^(?:authorization|control_?token|api_?key|secret)$/i.test(key)) {
      return "[REDACTED]";
    }
    if (
      value.startsWith("data:image/") ||
      (key === "data" && value.length > 512) ||
      (value.length > 4_096 && /^[A-Za-z0-9+/_=-]+$/.test(value))
    ) {
      return `[binary payload omitted: ${value.length} characters]`;
    }
    return value
      .replace(
        /(ARENA_CONTROL_TOKEN(?:["']?\s*[:=]\s*["']?))[A-Za-z0-9_-]+/gi,
        "$1[REDACTED]",
      )
      .replace(/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~-]+/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeTranscriptValue(entry, key, depth + 1));
  }
  const record = object(value);
  if (!record) return String(value);
  return Object.fromEntries(
    Object.entries(record).map(([childKey, childValue]) => [
      childKey,
      sanitizeTranscriptValue(childValue, childKey, depth + 1),
    ]),
  );
}
