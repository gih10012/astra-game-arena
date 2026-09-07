import assert from "node:assert/strict";
import test from "node:test";
import {
  virtualCameraFfmpegArguments,
  virtualCameraGameRecorderArguments,
} from "../src/virtual-camera.js";

test("builds a live 1920x1080 V4L2 composition without touching a real camera", () => {
  const capture = virtualCameraGameRecorderArguments("HEADLESS-1");
  assert.ok(capture.includes("-y"));
  assert.ok(capture.includes("-D"));
  assert.ok(capture.includes("pipe:1"));
  assert.equal(capture[capture.indexOf("-o") + 1], "HEADLESS-1");

  const output = virtualCameraFfmpegArguments({
    dashboardDisplay: ":99",
    device: "/dev/video10",
  });
  assert.equal(output.at(-1), "/dev/video10");
  assert.equal(output[output.indexOf("-f", output.indexOf("pipe:0")) + 1], "x11grab");
  assert.ok(output.join(" ").includes("hstack=inputs=2"));
  assert.ok(output.join(" ").includes("format=yuyv422"));
});
