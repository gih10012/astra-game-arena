import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  powerAllowsResume,
  readPowerState,
  shouldPauseForLowBattery,
} from "../src/power.js";

test("pauses at three percent only while discharging without power", () => {
  assert.equal(shouldPauseForLowBattery({
    batteryPercent: 3,
    discharging: true,
    externalPower: false,
  }), true);
  assert.equal(shouldPauseForLowBattery({
    batteryPercent: 3,
    discharging: false,
    externalPower: true,
  }), false);
  assert.equal(shouldPauseForLowBattery({
    batteryPercent: 4,
    discharging: true,
    externalPower: false,
  }), false);
});

test("reads battery and external-power state from Linux power_supply", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astra-power-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(path.join(root, "BAT0")),
    mkdir(path.join(root, "AC")),
  ]);
  await Promise.all([
    writeFile(path.join(root, "BAT0", "type"), "Battery\n"),
    writeFile(path.join(root, "BAT0", "capacity"), "3\n"),
    writeFile(path.join(root, "BAT0", "status"), "Discharging\n"),
    writeFile(path.join(root, "AC", "type"), "Mains\n"),
    writeFile(path.join(root, "AC", "online"), "0\n"),
  ]);
  assert.deepEqual(await readPowerState(root), {
    batteryPercent: 3,
    discharging: true,
    externalPower: false,
  });
});

test("resumes after charging or recovery above the threshold", () => {
  assert.equal(powerAllowsResume({
    batteryPercent: 2,
    discharging: false,
    externalPower: true,
  }), true);
  assert.equal(powerAllowsResume({
    batteryPercent: 3,
    discharging: true,
    externalPower: false,
  }), false);
  assert.equal(powerAllowsResume({
    batteryPercent: 4,
    discharging: true,
    externalPower: false,
  }), true);
});
