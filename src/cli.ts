#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlane } from "./control-plane.js";
import { runDoctor } from "./doctor.js";
import { runHeadlessSmoke } from "./headless-smoke.js";
import { runModelSmoke } from "./model-smoke.js";
import { CheckpointStore, readActiveRun } from "./run-checkpoint.js";
import { restoreFromRecovery } from "./save-guard.js";
import {
  assembleRecordings,
  runAssemblyWatcher,
} from "./recording-assembly.js";
import {
  cancelChallenge,
  queueChallenge,
  resumeChallenge,
  runChallenge,
  type RunOptions,
} from "./runner.js";
import {
  installAssemblyService,
  installWatchdogService,
  runWatchdog,
  uninstallWatchdogService,
  watchdogServiceStatus,
} from "./watchdog.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(
  sourceDirectory,
  import.meta.url.includes("/dist/") ? "../.." : "..",
);
const [command = "help", ...args] = process.argv.slice(2);

if (command === "doctor") {
  const requestedCodexHome = optionalPathArg(args, "--codex-home");
  const checks = await runDoctor(
    requestedCodexHome ? { codexHome: requestedCodexHome } : {},
  );
  if (args.includes("--json")) console.log(JSON.stringify(checks, null, 2));
  else {
    for (const check of checks) {
      const mark = check.ok ? "✓" : check.required ? "✗" : "!";
      console.log(`${mark} ${check.name.padEnd(34)} ${check.detail}`);
    }
  }
  if (checks.some((check) => check.required && !check.ok)) process.exitCode = 1;
} else if (command === "demo") {
  const port = numberArg(args, "--port", 4320);
  const duration = numberArg(args, "--duration", 0);
  const controlPlane = new ControlPlane(rootDirectory, { port });
  const url = await controlPlane.listen();
  console.log(`Arena control page: ${url}`);
  if (args.includes("--browser")) {
    spawn("google-chrome-stable", [`--app=${url}`], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
  if (duration > 0) {
    await new Promise((resolve) => setTimeout(resolve, duration * 1_000));
    await controlPlane.close();
  } else {
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await controlPlane.close();
  }
} else if (command === "run") {
  const outputIndex = args.indexOf("--output");
  const outputValue = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  const reasoning = stringArg(args, "--reasoning", "high") as
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | "ultra";
  if (!["low", "medium", "high", "xhigh", "max", "ultra"].includes(reasoning)) {
    throw new Error("--reasoning must be low, medium, high, xhigh, max, or ultra");
  }
  const requestedCodexHome = optionalPathArg(args, "--codex-home");
  const quotaWaitHours = numberArg(args, "--quota-wait-hours", 5);
  if (quotaWaitHours <= 0) throw new Error("--quota-wait-hours must be positive");
  const runOptions: RunOptions = {
    rootDirectory,
    publicPort: numberArg(args, "--port", 4317),
    port: numberArg(args, "--internal-port", 4318),
    model: stringArg(args, "--model", "gpt-6-astra"),
    gameAppId: stringArg(args, "--game", "1260520"),
    gpuPreference: stringArg(args, "--gpu", "auto") as "auto" | "integrated" | "discrete",
    offlineMode: args.includes("--offline"),
    goal: stringArg(args, "--goal", "Complete all official levels in Patrick's Parabox."),
    reasoningEffort: reasoning,
    record: !args.includes("--no-record"),
    virtualCamera: args.includes("--virtual-camera"),
    virtualCameraDevice: stringArg(args, "--virtual-camera", "/dev/video10"),
    openDashboard: args.includes("--browser"),
    isolateSaves: !args.includes("--keep-saves"),
    quotaWaitMs: quotaWaitHours * 60 * 60 * 1_000,
    ...(requestedCodexHome ? { codexHome: requestedCodexHome } : {}),
    ...(outputValue
      ? { output: path.resolve(outputValue) }
      : {}),
  };
  if (args.includes("--foreground")) {
    printOutcome(await runChallenge(runOptions));
  } else {
    const service = await watchdogServiceStatus();
    if (!service.active || !service.enabled) {
      throw new Error(
        "The watchdog must be active and enabled. Run: node dist/src/cli.js service install",
      );
    }
    const outcome = await queueChallenge(runOptions);
    console.log(`Challenge queued under ${service.service}.`);
    console.log(`Run artifacts: ${outcome.runDirectory}`);
    console.log(`Control and monitoring: http://127.0.0.1:${runOptions.publicPort}`);
    console.log("Status: node dist/src/cli.js status");
    console.log(
      `Logs: journalctl --user -u ${service.service} -f`,
    );
    console.log("You may close this terminal now.");
  }
} else if (command === "resume") {
  const runDirectory = args.find((argument) => !argument.startsWith("--"));
  if (!runDirectory) throw new Error("Usage: game-arena resume <run-directory>");
  printOutcome(await resumeChallenge(path.resolve(runDirectory)));
} else if (command === "cancel") {
  const runDirectory = args.find((argument) => !argument.startsWith("--"));
  if (!runDirectory) throw new Error("Usage: game-arena cancel <run-directory>");
  printOutcome(await cancelChallenge(path.resolve(runDirectory)));
} else if (command === "daemon") {
  await runWatchdog(rootDirectory, {
    pollMs: numberArg(args, "--poll-seconds", 1) * 1_000,
  });
} else if (command === "assembly-daemon") {
  await runAssemblyWatcher(rootDirectory, {
    pollMs: numberArg(args, "--poll-seconds", 10) * 1_000,
  });
} else if (command === "service") {
  const action = args[0] ?? "status";
  if (action === "install") {
    await installAssemblyService(rootDirectory);
    const servicePath = await installWatchdogService(rootDirectory);
    console.log(`Installed and started: ${servicePath}`);
  } else if (action === "install-assembler") {
    const servicePath = await installAssemblyService(rootDirectory);
    console.log(`Installed and started without restarting the challenge: ${servicePath}`);
  } else if (action === "uninstall") {
    await uninstallWatchdogService();
    console.log("Watchdog service removed.");
  } else if (action === "status") {
    console.log(JSON.stringify(await watchdogServiceStatus(), null, 2));
  } else {
    throw new Error(
      "Usage: game-arena service install|install-assembler|status|uninstall",
    );
  }
} else if (command === "status") {
  const active = await readActiveRun(rootDirectory);
  console.log(
    JSON.stringify(
      active ? (await CheckpointStore.load(active)).snapshot() : { active: false },
      null,
      2,
    ),
  );
} else if (command === "assemble") {
  const positional = args.find((argument, index) =>
    !argument.startsWith("--") && args[index - 1] !== "--output"
  );
  const runDirectory = positional
    ? path.resolve(positional)
    : await readActiveRun(rootDirectory);
  if (!runDirectory) {
    throw new Error("Usage: game-arena assemble [run-directory] [--output PATH]");
  }
  const requestedOutput = optionalPathArg(args, "--output");
  console.log(
    JSON.stringify(
      await assembleRecordings(runDirectory, requestedOutput),
      null,
      2,
    ),
  );
} else if (command === "smoke-model") {
  const result = await runModelSmoke(
    rootDirectory,
    optionalPathArg(args, "--codex-home"),
  );
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} else if (command === "smoke-headless") {
  console.log(JSON.stringify(await runHeadlessSmoke(rootDirectory), null, 2));
} else if (command === "restore") {
  const recovery = args[0];
  if (!recovery) throw new Error("Usage: game-arena restore <save-recovery.json>");
  await restoreFromRecovery(path.resolve(recovery));
  console.log("Save files restored.");
} else {
  console.log(`Astra Game Arena

Usage:
  game-arena doctor [--json] [--codex-home PATH]
  game-arena demo [--port 4320] [--duration SECONDS] [--browser]
  game-arena smoke-model [--codex-home PATH]
  game-arena smoke-headless
  game-arena run [--game APPID] [--gpu auto|integrated|discrete] [--goal TEXT] [--model MODEL] [--reasoning high] [--quota-wait-hours 5] [--codex-home PATH] [--no-record] [--virtual-camera /dev/video10] [--foreground]
  game-arena resume <run-directory>
  game-arena cancel <run-directory>
  game-arena status
  game-arena assemble [run-directory] [--output PATH]
  game-arena daemon [--poll-seconds 1]
  game-arena assembly-daemon [--poll-seconds 10]
  game-arena service install|install-assembler|status|uninstall
  game-arena restore <run/save-recovery.json>
`);
}

function numberArg(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function stringArg(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value ?? fallback;
}

function optionalPathArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (index >= 0 && !value) throw new Error(`${name} requires a path`);
  return value ? path.resolve(value) : undefined;
}

function printOutcome(outcome: {
  runDirectory: string;
  phase: string;
  retryAt: string | null;
  reason: string | null;
}): void {
  console.log(`Run artifacts: ${outcome.runDirectory}`);
  console.log(`Run phase: ${outcome.phase}`);
  if (outcome.retryAt) console.log(`Automatic retry: ${outcome.retryAt}`);
  if (outcome.reason) console.log(`Reason: ${outcome.reason}`);
}
