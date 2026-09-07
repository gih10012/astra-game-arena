import assert from "node:assert/strict";
import test from "node:test";
import {
  continuousGameRecorderArguments,
  dashboardRecorderArguments,
} from "../src/headless-display.js";

test("records the continuous private compositor and dashboard displays", () => {
  const game = continuousGameRecorderArguments({
    outputName: "HEADLESS-1",
    output: "/run/game.mkv",
  });
  assert.ok(game.includes("HEADLESS-1"));
  assert.ok(game.includes("30"));
  assert.ok(game.includes("--no-dmabuf"));
  assert.equal(game.at(-1), "/run/game.mkv");

  const dashboard = dashboardRecorderArguments({
    display: ":97",
    output: "/run/dashboard.mkv",
  });
  assert.ok(dashboard.includes(":97.0"));
  assert.ok(dashboard.includes("640x1080"));
  assert.ok(dashboard.includes("cfr"));
  assert.equal(dashboard.at(-1), "/run/dashboard.mkv");
  assert.equal([...game, ...dashboard].some((argument) => argument.includes("NIRI_SOCKET")), false);
});
