import { EventEmitter } from "node:events";
import {
  emptyTokenUsage,
  extractTokenUsage,
} from "./codex-events.js";
import { parseParaboxSave } from "./save-parser.js";
import {
  TARGET_LEVELS,
  type ChallengeSnapshot,
  type ChallengeStatus,
  type LevelProgress,
  type TokenSnapshot,
  type TokenUsage,
} from "./types.js";

export class ChallengeState extends EventEmitter {
  model: string;
  readonly targetLevels: number;
  goal: string;
  readonly game: { appId: string; name: string } | null;
  attempt: number;
  #runId: string | null = null;
  #status: ChallengeStatus = "idle";
  #startedAtWall: number | null = null;
  #startedAtMono: bigint | null = null;
  #elapsedBeforeMs = 0;
  #endedAtWall: number | null = null;
  #endedAtMono: bigint | null = null;
  #usage: TokenUsage = emptyTokenUsage();
  #providerTokenCursor: TokenUsage = emptyTokenUsage();
  #tokenSource: TokenSnapshot["source"] = "none";
  #progress: LevelProgress = { total: 0, unlocked: 0, completed: 0 };
  #failure: string | null = null;
  #completion: { summary: string; declaredAt: string } | null = null;

  constructor(
    model = "gpt-6-astra",
    targetLevels = TARGET_LEVELS,
    attempt = 1,
    goal = "",
    game: { appId: string; name: string } | null = null,
  ) {
    super();
    this.model = model;
    this.targetLevels = targetLevels;
    this.attempt = attempt;
    this.goal = goal;
    this.game = game;
  }

  start(
    runId: string,
    nowWall = Date.now(),
    nowMono = process.hrtime.bigint(),
    resume?: {
      elapsedMs: number;
      startedAt: string | null;
      tokens: TokenUsage;
      providerTokenCursor?: TokenUsage | null;
      progress: LevelProgress;
    },
  ): void {
    if (this.#status !== "idle") throw new Error("Challenge already started");
    this.#runId = runId;
    this.#status = "running";
    this.#startedAtWall = resume?.startedAt
      ? Date.parse(resume.startedAt)
      : nowWall;
    this.#startedAtMono = nowMono;
    this.#elapsedBeforeMs = Math.max(0, resume?.elapsedMs ?? 0);
    if (resume) {
      this.#usage = { ...resume.tokens };
      this.#providerTokenCursor = {
        ...(resume.providerTokenCursor ?? emptyTokenUsage()),
      };
      this.#progress = { ...resume.progress };
    }
    this.emit("change", this.snapshot());
  }

  ingestCodexEvent(event: unknown): void {
    const extracted = extractTokenUsage(event);
    if (!extracted) return;
    const next = extracted.usage;
    const reset = next.totalTokens < this.#providerTokenCursor.totalTokens;
    const delta = reset
      ? next
      : subtractUsage(next, this.#providerTokenCursor);
    this.#providerTokenCursor = reset
      ? { ...next }
      : maximumUsage(this.#providerTokenCursor, next);
    if (delta.totalTokens === 0) return;
    this.#usage = addUsage(this.#usage, delta);
    this.#tokenSource = extracted.source;
    this.emit("change", this.snapshot());
  }

  ingestSave(text: string): LevelProgress {
    this.#progress = parseParaboxSave(text);
    this.emit("change", this.snapshot());
    return this.#progress;
  }

  setModel(model: string): void {
    if (model === this.model) return;
    this.model = model;
    this.emit("change", this.snapshot());
  }

  setGoal(goal: string): void {
    if (goal === this.goal) return;
    this.goal = goal;
    this.emit("change", this.snapshot());
  }

  fail(message: string): void {
    this.#failure = message;
    if (this.#status === "idle") {
      this.#status = "failed";
      this.#endedAtWall = Date.now();
      this.#endedAtMono = process.hrtime.bigint();
      this.emit("change", this.snapshot());
      this.emit("finished", this.snapshot());
      return;
    }
    this.finish("failed");
  }

  stop(): void {
    this.finish("stopped");
  }

  complete(summary: string): void {
    const normalized = summary.trim();
    if (!normalized) throw new Error("Completion summary is required");
    if (this.#status !== "running") throw new Error("Challenge is not running");
    this.#completion = {
      summary: normalized,
      declaredAt: new Date().toISOString(),
    };
    this.finish("completed");
  }

  pause(
    nowWall = Date.now(),
    nowMono = process.hrtime.bigint(),
  ): void {
    if (this.#status !== "running" || this.#startedAtMono === null) return;
    this.#elapsedBeforeMs +=
      Number(nowMono - this.#startedAtMono) / 1_000_000;
    this.#startedAtMono = null;
    this.#endedAtMono = null;
    this.#endedAtWall = nowWall;
    this.#status = "stopped";
    this.emit("change", this.snapshot());
  }

  resume(
    attempt: number,
    nowWall = Date.now(),
    nowMono = process.hrtime.bigint(),
  ): void {
    if (this.#status !== "stopped") {
      throw new Error("Challenge is not paused");
    }
    this.attempt = attempt;
    this.#status = "running";
    this.#startedAtMono = nowMono;
    this.#endedAtMono = null;
    this.#endedAtWall = null;
    this.emit("change", this.snapshot());
  }

  finish(status: Exclude<ChallengeStatus, "idle" | "running">): void {
    if (this.#status !== "running") return;
    this.#status = status;
    this.#endedAtWall = Date.now();
    this.#endedAtMono = process.hrtime.bigint();
    this.emit("change", this.snapshot());
    this.emit("finished", this.snapshot());
  }

  timeSnapshot(nowWall = Date.now(), nowMono = process.hrtime.bigint()) {
    const elapsedMs =
      this.#startedAtMono === null
        ? this.#elapsedBeforeMs
        : this.#elapsedBeforeMs +
          Number((this.#endedAtMono ?? nowMono) - this.#startedAtMono) /
            1_000_000;
    return {
      status: this.#status,
      elapsedMs: Math.max(0, Math.round(elapsedMs)),
      startedAt:
        this.#startedAtWall === null
          ? null
          : new Date(this.#startedAtWall).toISOString(),
      endedAt:
        this.#endedAtWall === null
          ? null
          : new Date(this.#endedAtWall).toISOString(),
      sampledAt: new Date(nowWall).toISOString(),
    };
  }

  tokenSnapshot(): TokenSnapshot {
    return {
      ...this.#usage,
      source: this.#tokenSource,
      sampledAt: new Date().toISOString(),
    };
  }

  providerTokenCursorSnapshot(): TokenUsage {
    return { ...this.#providerTokenCursor };
  }

  snapshot(): ChallengeSnapshot {
    return {
      runId: this.#runId,
      model: this.model,
      goal: this.goal,
      game: this.game ? { ...this.game } : null,
      attempt: this.attempt,
      status: this.#status,
      targetLevels: this.targetLevels,
      progress: { ...this.#progress },
      time: this.timeSnapshot(),
      tokens: this.tokenSnapshot(),
      failure: this.#failure,
      completion: this.#completion ? { ...this.#completion } : null,
    };
  }
}

function subtractUsage(next: TokenUsage, current: TokenUsage): TokenUsage {
  return {
    inputTokens: Math.max(0, next.inputTokens - current.inputTokens),
    cachedInputTokens: Math.max(
      0,
      next.cachedInputTokens - current.cachedInputTokens,
    ),
    outputTokens: Math.max(0, next.outputTokens - current.outputTokens),
    reasoningOutputTokens: Math.max(
      0,
      next.reasoningOutputTokens - current.reasoningOutputTokens,
    ),
    totalTokens: Math.max(0, next.totalTokens - current.totalTokens),
  };
}

function maximumUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    cachedInputTokens: Math.max(left.cachedInputTokens, right.cachedInputTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    reasoningOutputTokens: Math.max(
      left.reasoningOutputTokens,
      right.reasoningOutputTokens,
    ),
    totalTokens: Math.max(left.totalTokens, right.totalTokens),
  };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens:
      left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}
