import assert from "node:assert/strict";
import test from "node:test";
import {
  virtualCameraBrowserStreamArguments,
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
  assert.ok(output.includes("1920x1080"));
  assert.ok(output.join(" ").includes("overlay=20:200"));
  assert.ok(output.join(" ").includes("force_original_aspect_ratio=decrease"));
  assert.ok(output.join(" ").includes("format=yuyv422"));
});

test("builds a 30 fps browser stream from the game region of the virtual camera", () => {
  const args = virtualCameraBrowserStreamArguments("/dev/video10");
  assert.deepEqual(args.slice(-3), ["-f", "mpjpeg", "pipe:1"]);
  assert.equal(args[args.indexOf("-i") + 1], "/dev/video10");
  assert.equal(args[args.indexOf("-vf") + 1], "crop=1248:810:20:200,fps=30");
  assert.equal(args[args.indexOf("-c:v") + 1], "mjpeg");
});
