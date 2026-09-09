import { runCommand } from "./command.js";

const WORKER_PREFIX = "astra-game-arena-runner-";

export function runWorkerUnitName(runId: string): string {
  const safe = runId.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
  if (!safe) throw new Error("Run id cannot be converted to a systemd unit name");
  return `${WORKER_PREFIX}${safe}.service`;
}

export async function runWorkerIsActive(runId: string): Promise<boolean> {
  const result = await runCommand("systemctl", [
    "--user",
    "is-active",
    runWorkerUnitName(runId),
  ]);
  return result.code === 0;
}

export async function launchRunWorker(options: {
  runId: string;
  rootDirectory: string;
  cliEntry: string;
  runDirectory: string;
}): Promise<string> {
  const unit = runWorkerUnitName(options.runId);
  if (await runWorkerIsActive(options.runId)) return unit;

  await runCommand("systemctl", ["--user", "reset-failed", unit])
    .catch(() => undefined);
  const result = await runCommand("systemd-run", [
    "--user",
    `--unit=${unit}`,
    "--collect",
    "--quiet",
    "--property=Type=exec",
    "--property=KillMode=control-group",
    "--property=TimeoutStopSec=30s",
    `--property=ExecStopPost=${process.execPath} ${options.cliEntry} cleanup-audio ${options.runId}`,
    `--working-directory=${options.rootDirectory}`,
    process.execPath,
    options.cliEntry,
    "resume",
    options.runDirectory,
  ], { timeoutMs: 15_000 });
  if (result.code !== 0) {
    throw new Error(
      result.stderr.toString("utf8").trim() ||
        `Could not start ${unit}`,
    );
  }
  return unit;
}

export async function stopRunWorker(
  runId: string,
  timeoutMs = 35_000,
): Promise<void> {
  const unit = runWorkerUnitName(runId);
  const result = await runCommand(
    "systemctl",
    ["--user", "stop", unit],
    { timeoutMs },
  );
  if (result.code !== 0 && !/not loaded|not found/i.test(
    `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`,
  )) {
    throw new Error(result.stderr.toString("utf8").trim() || `Could not stop ${unit}`);
  }
}
