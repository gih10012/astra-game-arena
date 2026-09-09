import assert from "node:assert/strict";
import test from "node:test";
import { retryIsDue } from "../src/watchdog.js";

test("resumes immediately when a quota deadline passed during system sleep", () => {
  const wakeTime = Date.parse("2026-09-06T12:00:00.000Z");
  assert.equal(retryIsDue("2026-09-06T11:59:59.000Z", wakeTime), true);
  assert.equal(retryIsDue("2026-09-06T12:00:00.000Z", wakeTime), true);
  assert.equal(retryIsDue("2026-09-06T12:00:01.000Z", wakeTime), false);
  assert.equal(retryIsDue(null, wakeTime), true);
});
