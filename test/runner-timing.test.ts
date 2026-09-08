import assert from "node:assert/strict";
import test from "node:test";
import { ChallengeState } from "../src/challenge-state.js";
import {
  activateTimedAttempt,
  interruptActiveTiming,
  recordingFailureOutcome,
} from "../src/runner.js";

test("freezes active timing synchronously and repeated interrupts cannot leak time", () => {
  const state = new ChallengeState();
  state.start("run", 1_000, 1_000_000_000n);
  let elapsedInsideInterrupt = -1;
  interruptActiveTiming(
    state,
    () => {
      elapsedInsideInterrupt = state.timeSnapshot(9_000, 9_000_000_000n).elapsedMs;
    },
    1_250,
    1_250_000_000n,
  );
  interruptActiveTiming(state, () => undefined, 8_000, 8_000_000_000n);

  assert.equal(elapsedInsideInterrupt, 250);
  assert.equal(state.timeSnapshot(20_000, 20_000_000_000n).elapsedMs, 250);
});

test("does not activate an attempt after a stop or without required recorder coverage", () => {
  let activations = 0;
  const activate = () => {
    activations += 1;
  };
  assert.equal(activateTimedAttempt({
    stopRequested: true,
    recordingRequired: false,
    recordingActive: false,
    activate,
  }), false);
  assert.equal(activateTimedAttempt({
    stopRequested: false,
    recordingRequired: true,
    recordingActive: false,
    activate,
  }), false);
  assert.equal(activateTimedAttempt({
    stopRequested: false,
    recordingRequired: true,
    recordingActive: true,
    activate,
  }), true);
  assert.equal(activations, 1);
});

test("schedules recorder coverage failures as ordinary attempt retries", () => {
  assert.deepEqual(
    recordingFailureOutcome(2, "Recording coverage failed", 1_000),
    {
      phase: "waiting_retry",
      retryAt: "1970-01-01T00:02:01.000Z",
      reason: "Recording coverage failed",
    },
  );
});
