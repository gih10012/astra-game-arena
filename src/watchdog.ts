import { access, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./command.js";
import {
  CheckpointStore,
  clearActiveRun,
  isTerminal,
  processMatches,
  readActiveRun,
} from "./run-checkpoint.js";
import {
  powerAllowsResume,
  readPowerState,
  shouldPauseForLowBattery,
} from "./power.js";
import { ControlPlane } from "./control-plane.js";
import { launchRunWorker, runWorkerIsActive } from "./run-worker.js";
import { cleanupPrivateGameAudio } from "./private-audio.js";

const SERVICE_NAME = "astra-game-arena-watchdog.service";
const ASSEMBLY_SERVICE_NAME = "astra-game-arena-assembler.service";
const LEGACY_SERVICE_NAMES = [
  "astra-parabox-watchdog.service",
  "astra-parabox-assembler.service",
] as const;
const sessionVariables = [
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
] as const;

export async function runWatchdog(
  rootDirectory: string,
  options: { pollMs?: number; cliEntry?: string } = {},
): Promise<void> {
  const root = path.resolve(rootDirectory);
  const pollMs = Math.max(1_000, options.pollMs ?? 1_000);
  const cliEntry = path.resolve(
    options.cliEntry ?? path.join(root, "dist/src/cli.js"),
  );
  let stopping = false;
  const controlPlane = new ControlPlane(root, { port: 4317 });
  const controlUrl = await controlPlane.listen();
  let wakePending: (() => void) | null = null;
  const wait = (milliseconds: number) =>
    new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        if (wakePending === finish) wakePending = null;
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, milliseconds));
      wakePending = finish;
    });
  const wake = () => wakePending?.();
  const stop = () => {
    stopping = true;
    wake();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    console.log(`Astra Game Arena supervisor ready: ${root}`);
    console.log(`Control plane: ${controlUrl}`);
    while (!stopping) {
      const runDirectory = await readActiveRun(root);
      if (!runDirectory) {
        await wait(pollMs);
        continue;
      }

      let store: CheckpointStore;
      try {
        store = await CheckpointStore.load(runDirectory);
      } catch (error) {
        console.error(`Cannot read active checkpoint: ${String(error)}`);
        await wait(pollMs);
        continue;
      }
      let checkpoint = store.snapshot();
      if (isTerminal(checkpoint.phase)) {
        await clearActiveRun(root, runDirectory);
        continue;
      }
      if (checkpoint.phase === "paused") {
        await wait(pollMs);
        continue;
      }
      if (
        checkpoint.pid !== null &&
        processMatches(checkpoint.pid, checkpoint.pidStartTicks)
      ) {
        await wait(pollMs);
        continue;
      }
      if (await runWorkerIsActive(checkpoint.runId)) {
        await wait(pollMs);
        continue;
      }
      const power = await readPowerState();
      if (shouldPauseForLowBattery(power)) {
        if (checkpoint.phase !== "waiting_power") {
          checkpoint = await store.update({
            phase: "waiting_power",
            pid: null,
            pidStartTicks: null,
            retryAt: null,
            reason: `Battery at ${power.batteryPercent}%; waiting for external power`,
          });
        }
        await wait(pollMs);
        continue;
      }
      if (checkpoint.phase === "waiting_power" && !powerAllowsResume(power)) {
        await wait(pollMs);
        continue;
      }
      if (checkpoint.attempt > 0) {
        await cleanupPrivateGameAudio(checkpoint.runId).catch(() => undefined);
        await store.update({
          phase: "paused",
          pid: null,
          pidStartTicks: null,
          gameRuntimeReady: false,
          gameRuntimeFrozen: false,
          retryAt: null,
          reason:
            "Exact in-memory runtime is unavailable; automatic game relaunch is disabled",
        });
        continue;
      }

      const retryTime = checkpoint.retryAt
        ? Date.parse(checkpoint.retryAt)
        : Date.now();
      if (!retryIsDue(checkpoint.retryAt)) {
        await wait(Math.min(pollMs, retryTime - Date.now()));
        continue;
      }

      const environment = await userRuntimeEnvironment();
      if (!(await userRuntimeReady(environment))) {
        await wait(pollMs);
        continue;
      }

      console.log(
        `Resuming ${checkpoint.runId}, attempt ${checkpoint.attempt + 1}`,
      );
      try {
        await launchRunWorker({
          runId: checkpoint.runId,
          rootDirectory: root,
          cliEntry,
          runDirectory,
        });
      } catch (error) {
        console.error(`Cannot start challenge worker: ${String(error)}`);
        await store.update({
          phase: "waiting_retry",
          pid: null,
          pidStartTicks: null,
          gameRuntimeReady: false,
          gameRuntimeFrozen: false,
          retryAt: new Date(Date.now() + 10_000).toISOString(),
          reason: `Challenge worker launch failed: ${String(error)}`,
        });
      }
      if (!stopping) await wait(1_000);
    }
  } finally {
    wake();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await controlPlane.close();
  }
}

export function retryIsDue(
  retryAt: string | null,
  nowMs = Date.now(),
): boolean {
  if (!retryAt) return true;
  const retryTime = Date.parse(retryAt);
  return !Number.isFinite(retryTime) || retryTime <= nowMs;
}

export async function installWatchdogService(
  rootDirectory: string,
): Promise<string> {
  const root = path.resolve(rootDirectory);
  const serviceDirectory = path.join(os.homedir(), ".config/systemd/user");
  const servicePath = path.join(serviceDirectory, SERVICE_NAME);
  const cliEntry = path.join(root, "dist/src/cli.js");
  await mkdir(serviceDirectory, { recursive: true });
  const unit = `[Unit]
Description=Astra Game Arena supervisor and control plane
After=default.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${systemdPath(root)}
ExecStart=${systemdQuote(process.execPath)} ${systemdQuote(cliEntry)} daemon
Restart=always
RestartSec=10
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;
  await writeFile(servicePath, unit, { mode: 0o644 });
  const presentVariables = sessionVariables.filter(
    (name) => process.env[name] !== undefined,
  );
  if (presentVariables.length > 0) {
    await runCommand("systemctl", [
      "--user",
      "import-environment",
      ...presentVariables,
    ]);
  }
  await removeLegacyServices();
  await expectSystemctl(["daemon-reload"]);
  await expectSystemctl(["enable", SERVICE_NAME]);
  await expectSystemctl(["restart", SERVICE_NAME]);
  return servicePath;
}

export async function installAssemblyService(
  rootDirectory: string,
): Promise<string> {
  const root = path.resolve(rootDirectory);
  const serviceDirectory = path.join(os.homedir(), ".config/systemd/user");
  const servicePath = path.join(serviceDirectory, ASSEMBLY_SERVICE_NAME);
  const cliEntry = path.join(root, "dist/src/cli.js");
  await mkdir(serviceDirectory, { recursive: true });
  const unit = `[Unit]
Description=Astra Game Arena video assembler
After=default.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${systemdPath(root)}
ExecStart=${systemdQuote(process.execPath)} ${systemdQuote(cliEntry)} assembly-daemon
Restart=always
RestartSec=10
TimeoutStopSec=30
Nice=10
IOSchedulingClass=idle

[Install]
WantedBy=default.target
`;
  await writeFile(servicePath, unit, { mode: 0o644 });
  await runCommand("systemctl", [
    "--user", "disable", "--now", "astra-parabox-assembler.service",
  ]);
  await rm(
    path.join(serviceDirectory, "astra-parabox-assembler.service"),
    { force: true },
  );
  await expectSystemctl(["daemon-reload"]);
  await expectSystemctl(["enable", ASSEMBLY_SERVICE_NAME]);
  await expectSystemctl(["restart", ASSEMBLY_SERVICE_NAME]);
  return servicePath;
}

export async function uninstallWatchdogService(): Promise<void> {
  await runCommand("systemctl", [
    "--user",
    "disable",
    "--now",
    SERVICE_NAME,
    ASSEMBLY_SERVICE_NAME,
    ...LEGACY_SERVICE_NAMES,
  ]);
  await rm(
    path.join(os.homedir(), ".config/systemd/user", SERVICE_NAME),
    { force: true },
  );
  await rm(
    path.join(os.homedir(), ".config/systemd/user", ASSEMBLY_SERVICE_NAME),
    { force: true },
  );
  for (const legacy of LEGACY_SERVICE_NAMES) {
    await rm(path.join(os.homedir(), ".config/systemd/user", legacy), {
      force: true,
    });
  }
  await expectSystemctl(["daemon-reload"]);
}

async function removeLegacyServices(): Promise<void> {
  await runCommand("systemctl", [
    "--user", "disable", "--now", ...LEGACY_SERVICE_NAMES,
  ]);
  const serviceDirectory = path.join(os.homedir(), ".config/systemd/user");
  await Promise.all(
    LEGACY_SERVICE_NAMES.map((name) =>
      rm(path.join(serviceDirectory, name), { force: true })
    ),
  );
}

export async function watchdogServiceStatus(): Promise<{
  service: string;
  active: boolean;
  enabled: boolean;
  assemblerService: string;
  assemblerActive: boolean;
  assemblerEnabled: boolean;
}> {
  const active = await runCommand("systemctl", [
    "--user",
    "is-active",
    SERVICE_NAME,
  ]);
  const enabled = await runCommand("systemctl", [
    "--user",
    "is-enabled",
    SERVICE_NAME,
  ]);
  const assemblerActive = await runCommand("systemctl", [
    "--user",
    "is-active",
    ASSEMBLY_SERVICE_NAME,
  ]);
  const assemblerEnabled = await runCommand("systemctl", [
    "--user",
    "is-enabled",
    ASSEMBLY_SERVICE_NAME,
  ]);
  return {
    service: SERVICE_NAME,
    active: active.code === 0,
    enabled: enabled.code === 0,
    assemblerService: ASSEMBLY_SERVICE_NAME,
    assemblerActive: assemblerActive.code === 0,
    assemblerEnabled: assemblerEnabled.code === 0,
  };
}

async function userRuntimeEnvironment(): Promise<NodeJS.ProcessEnv> {
  const environment = { ...process.env };
  const result = await runCommand("systemctl", ["--user", "show-environment"]);
  if (result.code !== 0) return environment;
  for (const line of result.stdout.toString("utf8").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator);
    if (!sessionVariables.includes(name as (typeof sessionVariables)[number])) {
      continue;
    }
    environment[name] = line.slice(separator + 1);
  }
  if (!environment.XDG_RUNTIME_DIR) {
    const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
    environment.XDG_RUNTIME_DIR = `/run/user/${uid}`;
  }
  return environment;
}

async function userRuntimeReady(env: NodeJS.ProcessEnv): Promise<boolean> {
  return await pathExists(env.XDG_RUNTIME_DIR);
}

async function pathExists(filename: string | undefined): Promise<boolean> {
  if (!filename) return false;
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

function systemdQuote(value: string): string {
  return `"${value
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')}"`;
}

function systemdPath(value: string): string {
  return value
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\x5c")
    .replaceAll(" ", "\\x20")
    .replaceAll("\t", "\\x09");
}

async function expectSystemctl(args: string[]): Promise<void> {
  const result = await runCommand("systemctl", ["--user", ...args]);
  if (result.code !== 0) {
    throw new Error(result.stderr.toString("utf8").trim() || "systemctl failed");
  }
}
