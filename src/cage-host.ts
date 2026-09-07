#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { runCommand } from "./command.js";

const [anchor, ...anchorArguments] = process.argv.slice(2);
if (!anchor) throw new Error("cage-host requires an X11 anchor command");

const outputsResult = await runCommand("wlr-randr", ["--json"], {
  env: process.env,
  timeoutMs: 5_000,
});
if (outputsResult.code !== 0) {
  throw new Error(`Cannot inspect Cage output: ${outputsResult.stderr.toString("utf8").trim()}`);
}
const outputs = JSON.parse(outputsResult.stdout.toString("utf8")) as Array<{ name?: string }>;
const output = outputs[0]?.name;
if (!output) throw new Error("Cage output is unavailable");
const modeResult = await runCommand(
  "wlr-randr",
  ["--output", output, "--custom-mode", "1920x1080@30Hz"],
  { env: process.env, timeoutMs: 5_000 },
);
if (modeResult.code !== 0) {
  throw new Error(`Cannot configure Cage output: ${modeResult.stderr.toString("utf8").trim()}`);
}

const child: ChildProcess = spawn(anchor, anchorArguments, {
  env: process.env,
  detached: true,
  stdio: "inherit",
});
const forward = (signal: NodeJS.Signals) => {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
};
process.once("SIGINT", () => forward("SIGINT"));
process.once("SIGTERM", () => forward("SIGTERM"));
const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
if (signal) process.kill(process.pid, signal);
else process.exitCode = code ?? 1;
