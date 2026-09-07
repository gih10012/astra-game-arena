import assert from "node:assert/strict";
import test from "node:test";
import { ChallengeState } from "../src/challenge-state.js";

function save(total: number, completed: number): string {
  const rows = Array.from(
    { length: total },
    (_, index) => `level_${index} 1 ${index < completed ? 1 : 0}`,
  );
  return `-section levels\n${rows.join("\n")}\n`;
}

test("uses monotonic time and completes only after the agent declares success", () => {
  const state = new ChallengeState("gpt-6-astra", 3);
  state.start("run", 1_000, 5_000_000_000n);
  assert.equal(state.timeSnapshot(2_000, 5_250_000_000n).elapsedMs, 250);
  state.ingestSave(save(2, 2));
  assert.equal(state.snapshot().status, "running");
  state.ingestSave(save(3, 3));
  assert.equal(state.snapshot().status, "running");
  assert.equal(state.snapshot().progress.completed, 3);
  state.complete("All visible objectives are complete.");
  assert.equal(state.snapshot().status, "completed");
  assert.equal(state.snapshot().completion?.summary, "All visible objectives are complete.");
});

test("adds provider counters across turns without double-counting samples", () => {
  const state = new ChallengeState();
  state.ingestCodexEvent({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          output_tokens: 20,
          reasoning_output_tokens: 8,
          total_tokens: 120,
        },
      },
    },
  });
  const completedTurn = {
    type: "turn.completed",
    usage: {
      input_tokens: 50,
      cached_input_tokens: 10,
      output_tokens: 10,
      reasoning_output_tokens: 2,
    },
  };
  state.ingestCodexEvent(completedTurn);
  state.ingestCodexEvent(completedTurn);
  const snapshot = state.tokenSnapshot();
  assert.deepEqual(snapshot, {
    inputTokens: 150,
    cachedInputTokens: 50,
    outputTokens: 30,
    reasoningOutputTokens: 10,
    totalTokens: 180,
    source: "exec",
    sampledAt: snapshot.sampledAt,
  });
});

test("restores cumulative metrics when a run resumes", () => {
  const state = new ChallengeState("gpt-6-astra", 3);
  state.start("run", 10_000, 20_000_000_000n, {
    elapsedMs: 5_000,
    startedAt: "1970-01-01T00:00:01.000Z",
    tokens: {
      inputTokens: 90,
      cachedInputTokens: 40,
      outputTokens: 10,
      reasoningOutputTokens: 5,
      totalTokens: 100,
    },
    progress: { total: 3, unlocked: 2, completed: 1 },
  });
  assert.equal(state.timeSnapshot(11_000, 20_250_000_000n).elapsedMs, 5_250);
  assert.equal(state.timeSnapshot().startedAt, "1970-01-01T00:00:01.000Z");
  assert.equal(state.tokenSnapshot().totalTokens, 100);
  assert.equal(state.snapshot().progress.completed, 1);
});

test("continues from a persisted provider token cursor", () => {
  const state = new ChallengeState();
  state.start("run", 10_000, 20_000_000_000n, {
    elapsedMs: 0,
    startedAt: "1970-01-01T00:00:01.000Z",
    tokens: {
      inputTokens: 900,
      cachedInputTokens: 400,
      outputTokens: 100,
      reasoningOutputTokens: 50,
      totalTokens: 1_000,
    },
    providerTokenCursor: {
      inputTokens: 90,
      cachedInputTokens: 40,
      outputTokens: 10,
      reasoningOutputTokens: 5,
      totalTokens: 100,
    },
    progress: { total: 0, unlocked: 0, completed: 0 },
  });
  state.ingestCodexEvent({
    type: "turn.completed",
    usage: {
      input_tokens: 135,
      cached_input_tokens: 60,
      output_tokens: 15,
      reasoning_output_tokens: 7,
      total_tokens: 150,
    },
  });
  assert.equal(state.tokenSnapshot().totalTokens, 1_050);
  state.ingestCodexEvent({
    type: "turn.completed",
    usage: {
      input_tokens: 18,
      cached_input_tokens: 8,
      output_tokens: 2,
      reasoning_output_tokens: 1,
      total_tokens: 20,
    },
  });
  assert.equal(state.tokenSnapshot().totalTokens, 1_070);
  assert.equal(state.providerTokenCursorSnapshot().totalTokens, 20);
});

test("pauses quota time and resumes the same state with a new attempt", () => {
  const state = new ChallengeState("gpt-6-astra", 364, 1);
  state.start("run", 1_000, 1_000_000_000n);
  state.pause(2_000, 2_000_000_000n);
  assert.equal(state.timeSnapshot(12_000, 12_000_000_000n).elapsedMs, 1_000);
  state.resume(2, 12_000, 12_000_000_000n);
  const snapshot = state.snapshot();
  assert.equal(snapshot.attempt, 2);
  assert.equal(
    state.timeSnapshot(13_000, 13_000_000_000n).elapsedMs,
    2_000,
  );
});
