import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { AuditLog } from "./audit-log.js";
import { ChallengeState } from "./challenge-state.js";
import { runCommand } from "./command.js";
import { ArenaController } from "./controller.js";
import { defaultGamePaths } from "./doctor.js";
import { X11GameAdapter } from "./game-adapter.js";
import {
  startVirtualDashboard,
  startVirtualGame,
  type VirtualDashboardRuntime,
  type VirtualGameRuntime,
} from "./headless-display.js";
import {
  startRecordingPair,
  stopAndComposeRecordingPair,
  type ActiveRecordingPair,
} from "./recording-pair.js";
import { SaveGuard } from "./save-guard.js";
import { TARGET_LEVELS } from "./types.js";
import { findInstalledSteamGame } from "./steam-catalog.js";

export async function runHeadlessSmoke(rootDirectory: string): Promise<{
  display: string;
  windowId: number;
  title: string;
  before: { filename: string; sha256: string };
  after: { filename: string; sha256: string };
  recording: { filename: string; bytes: number; durationSeconds: number };
}> {
  const output = path.join(
    rootDirectory,
    ".arena",
    `headless-smoke-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
  );
  const frameDirectory = path.join(output, "frames");
  const runtimeDirectory = path.join(output, "runtime");
  await mkdir(frameDirectory, { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  const audit = new AuditLog(output);
  await audit.initialize({ type: "headless-smoke", modelTokens: 0 });
  const saveGuard = new SaveGuard(defaultGamePaths().saveDirectory, output);
  await saveGuard.prepare();
  let runtime: VirtualGameRuntime | null = null;
  let game: X11GameAdapter | null = null;
  let controller: ArenaController | null = null;
  let dashboard: VirtualDashboardRuntime | null = null;
  let recorder: ActiveRecordingPair | null = null;
  try {
    runtime = await startVirtualGame({
      rootDirectory,
      runtimeDirectory,
      game: await findInstalledSteamGame("1260520"),
    });
    game = new X11GameAdapter({
      display: runtime.display,
      frameDirectory,
      keypressCommand: runtime.keypressCommand,
      compositorScreenshot: runtime.compositorScreenshot,
    });
    const discovered = await waitForGame(game, 120_000);
    const visible = await game.waitForVisibleFrame(120_000);
    const before = visible.frame;
    const state = new ChallengeState("gpt-6-astra", TARGET_LEVELS);
    controller = new ArenaController({
      state,
      game,
      port: 0,
      webRoot: path.join(rootDirectory, "web"),
    });
    const url = await controller.listen();
    state.start("headless-smoke");
    state.ingestCodexEvent({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 12840,
            cached_input_tokens: 8192,
            output_tokens: 756,
            reasoning_output_tokens: 410,
            total_tokens: 13596,
          },
        },
      },
    });
    controller.publishTranscript({ type: "turn.started" });
    controller.publishTranscript({
      type: "item.completed",
      item: {
        type: "reasoning",
        text: "Verifying the isolated game, controls, dashboard, and recorder.",
      },
    });
    await fetch(new URL("/internal/observe", url), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${controller.controlToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    dashboard = await startVirtualDashboard({
      rootDirectory,
      runtimeDirectory,
      url,
    });
    recorder = await startRecordingPair({
      runDirectory: output,
      attempt: 1,
      game: runtime,
      dashboard,
      audit,
    });
    await game.clickPointer(512, 930, "left", 1);
    await delay(1_800);
    const after = await game.capture();
    const afterFilename = game.latestFrameFilename();
    controller.publishFrame(after);
    await game.press(["DOWN"], { intervalMs: 80, settleMs: 500 });
    controller.publishFrame(await game.capture());
    await game.press(["UP"], { intervalMs: 80, settleMs: 100 });
    await game.movePointer(640, 540);
    await delay(2_500);
    const recordingRelative = await stopAndComposeRecordingPair(output, recorder);
    recorder = null;
    const recordingPath = path.join(output, recordingRelative);
    const recordingSize = (await stat(recordingPath)).size;
    const durationSeconds = await validateRecording(recordingPath);
    return {
      display: runtime.display,
      ...discovered,
      before: {
        filename: visible.filename,
        sha256: before.sha256,
      },
      after: {
        filename: afterFilename,
        sha256: after.sha256,
      },
      recording: {
        filename: recordingPath,
        bytes: recordingSize,
        durationSeconds,
      },
    };
  } finally {
    if (recorder) {
      await stopAndComposeRecordingPair(output, recorder).catch(() => undefined);
    }
    await dashboard?.close().catch(() => undefined);
    await controller?.close().catch(() => undefined);
    await game?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await saveGuard.restore();
  }
}

async function validateRecording(filename: string): Promise<number> {
  const probe = await runCommand("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    filename,
  ]);
  const duration = Number(probe.stdout.toString("utf8").trim());
  if (probe.code !== 0 || duration < 4.5 || duration > 15) {
    throw new Error(`Unexpected smoke recording duration: ${duration}`);
  }
  const decode = await runCommand("ffmpeg", [
    "-nostdin", "-v", "error", "-i", filename, "-f", "null", "-",
  ], { timeoutMs: 30_000 });
  if (decode.code !== 0 || decode.stderr.length > 0) {
    throw new Error(`Smoke recording decode failed: ${decode.stderr.toString("utf8")}`);
  }
  const frames = await runCommand("ffmpeg", [
    "-nostdin", "-v", "error", "-i", filename,
    "-vf", "crop=1280:1080:0:0,fps=1",
    "-f", "framemd5", "-",
  ], { timeoutMs: 30_000 });
  const hashes = new Set(
    frames.stdout.toString("utf8").split("\n")
      .filter((line) => /^\d/.test(line))
      .map((line) => line.split(",").at(-1)?.trim())
      .filter(Boolean),
  );
  if (frames.code !== 0 || hashes.size < 2) {
    throw new Error("Smoke recording does not contain a continuously changing native game pane");
  }
  return duration;
}

async function waitForGame(
  game: X11GameAdapter,
  timeoutMs: number,
): Promise<{ windowId: number; title: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await game.discover();
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Game window timeout");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
