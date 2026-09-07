import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectCommand } from "./command.js";
import {
  CheckpointStore,
  durableJsonWrite,
  readActiveRun,
  type RunCheckpoint,
} from "./run-checkpoint.js";

const ASSEMBLY_VERSION = 2;
const FRAMES_PER_SECOND = 30;
const LEGACY_RECORDER_PROBE_MS = 1_000;

interface AuditEvent {
  at: string;
  type: string;
  data: unknown;
}

export interface RecordingCut {
  attempt: number;
  trimStartSeconds: number;
  activeDurationSeconds: number | null;
}

export interface RecordingAssembly {
  output: string;
  complete: boolean;
  durationSeconds: number;
  bytes: number;
  sources: string[];
  cuts: RecordingCut[];
  trimmedResumeSeconds: number;
  omittedOpenRecording: string | null;
}

export function sealedRecordingNames(checkpoint: RunCheckpoint): {
  names: string[];
  omittedOpenRecording: string | null;
} {
  const names = [...checkpoint.recordings];
  const last = names.at(-1) ?? null;
  const lastMayStillBeOpen =
    last !== null &&
    (checkpoint.phase === "starting" || checkpoint.phase === "running");
  return {
    names: lastMayStillBeOpen ? names.slice(0, -1) : names,
    omittedOpenRecording: lastMayStillBeOpen ? last : null,
  };
}

export async function assembleRecordings(
  requestedRunDirectory: string,
  requestedOutput?: string,
): Promise<RecordingAssembly> {
  const runDirectory = path.resolve(requestedRunDirectory);
  const checkpoint = (await CheckpointStore.load(runDirectory)).snapshot();
  const selection = sealedRecordingNames(checkpoint);
  if (selection.names.length === 0) {
    throw new Error("No sealed recording parts are available yet");
  }

  const sources: string[] = [];
  for (const name of selection.names) {
    sources.push(await releaseRecordingPath(runDirectory, name));
  }
  const cuts = recordingCuts(
    await readAuditEvents(path.join(runDirectory, "events.jsonl")),
    selection.names,
  );

  const productionDirectory = path.join(runDirectory, "production");
  await mkdir(productionDirectory, { recursive: true });
  const output = path.resolve(
    requestedOutput ??
      path.join(
        productionDirectory,
        checkpoint.phase === "completed"
          ? "challenge-complete.mkv"
          : "challenge-production-so-far.mkv",
      ),
  );
  const assemblySignature = {
    version: ASSEMBLY_VERSION,
    method: "snapshot-boundary-cut",
    output,
    complete: checkpoint.phase === "completed",
    sources,
    cuts,
  };
  const metadataPath = path.join(productionDirectory, "assembly.json");
  try {
    const existing = JSON.parse(await readFile(metadataPath, "utf8")) as {
      signature?: unknown;
      result?: RecordingAssembly;
    };
    await access(output);
    if (
      existing.result &&
      JSON.stringify(existing.signature) === JSON.stringify(assemblySignature)
    ) {
      return {
        ...existing.result,
        omittedOpenRecording: selection.omittedOpenRecording,
      };
    }
  } catch {
    // No current cumulative output; normalize and assemble the sealed parts.
  }
  const normalizedSources: string[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const cut = cuts[index];
    if (!source || !cut) throw new Error("Recording assembly plan is incomplete");
    normalizedSources.push(
      await normalizeRecording(source, cut, productionDirectory),
    );
  }
  const identifier = randomUUID();
  const listPath = path.join(productionDirectory, `.concat-${identifier}.ffconcat`);
  const temporaryOutput = path.join(
    path.dirname(output),
    `.${path.basename(output)}.${identifier}.partial.mkv`,
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    listPath,
    `ffconcat version 1.0\n${normalizedSources.map((source) => `file '${ffconcatEscape(source)}'`).join("\n")}\n`,
  );

  try {
    await expectCommand(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "warning",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-c:v",
        "copy",
        "-f",
        "matroska",
        temporaryOutput,
      ],
      { timeoutMs: 10 * 60_000 },
    );
    const { durationSeconds, bytes } = await validateVideo(temporaryOutput);
    await rename(temporaryOutput, output);
    const result: RecordingAssembly = {
      output,
      complete: checkpoint.phase === "completed",
      durationSeconds,
      bytes,
      sources,
      cuts,
      trimmedResumeSeconds: cuts.reduce(
        (total, cut) => total + cut.trimStartSeconds,
        0,
      ),
      omittedOpenRecording: selection.omittedOpenRecording,
    };
    await durableJsonWrite(metadataPath, {
      version: ASSEMBLY_VERSION,
      method: "snapshot-boundary-cut",
      assembledAt: new Date().toISOString(),
      runId: checkpoint.runId,
      phase: checkpoint.phase,
      signature: assemblySignature,
      result,
    });
    return result;
  } finally {
    await rm(listPath, { force: true });
    await rm(temporaryOutput, { force: true });
  }
}

export async function runAssemblyWatcher(
  rootDirectory: string,
  options: { pollMs?: number } = {},
): Promise<void> {
  const root = path.resolve(rootDirectory);
  const pollMs = Math.max(1_000, options.pollMs ?? 10_000);
  let stopping = false;
  let lastRunDirectory: string | null = null;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopping) {
      const runDirectory = await readActiveRun(root);
      if (runDirectory) lastRunDirectory = runDirectory;
      const assemblyTarget = runDirectory ?? lastRunDirectory;
      if (assemblyTarget) {
        try {
          await assembleRecordings(assemblyTarget);
        } catch (error) {
          console.error(`Cumulative recording refresh failed: ${String(error)}`);
        }
        if (!runDirectory) lastRunDirectory = null;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

export function recordingCuts(
  events: AuditEvent[],
  recordingNames: string[],
): RecordingCut[] {
  const recordings = new Map<number, { eventAtMs: number; captureAtMs: number }>();
  const activeStarts = new Map<number, { eventAtMs: number; elapsedMs: number }>();
  const activeEnds = new Map<number, number>();
  for (const event of events) {
    const data = objectValue(event.data);
    const attempt = numberValue(data?.attempt);
    if (attempt === null) continue;
    if (event.type === "recording.started") {
      const eventAtMs = Date.parse(event.at);
      const explicitCaptureAtMs = Date.parse(stringValue(data?.captureStartedAt) ?? "");
      if (Number.isFinite(eventAtMs)) {
        recordings.set(attempt, {
          eventAtMs,
          captureAtMs: Number.isFinite(explicitCaptureAtMs)
            ? explicitCaptureAtMs
            : eventAtMs - LEGACY_RECORDER_PROBE_MS,
        });
      }
    }
    if (event.type === "challenge.started" || event.type === "challenge.resumed") {
      const eventAtMs = Date.parse(event.at);
      const elapsedMs = nestedElapsedMs(data);
      if (Number.isFinite(eventAtMs) && elapsedMs !== null) {
        activeStarts.set(attempt, { eventAtMs, elapsedMs });
      }
    }
    if (event.type === "attempt.finished") {
      const elapsedMs = nestedElapsedMs(data);
      if (elapsedMs !== null) activeEnds.set(attempt, elapsedMs);
    }
  }

  const sortedStarts = [...activeStarts.entries()].sort(([left], [right]) => left - right);
  return recordingNames.map((name) => {
    const attempt = recordingAttempt(name);
    const recording = recordings.get(attempt);
    const activeStart = activeStarts.get(attempt);
    let endElapsedMs = activeEnds.get(attempt) ?? null;
    if (endElapsedMs === null && activeStart) {
      endElapsedMs =
        sortedStarts.find(([candidate]) => candidate > attempt)?.[1].elapsedMs ?? null;
    }
    const trimStartSeconds =
      attempt === 1 || !recording || !activeStart
        ? 0
        : frameCeiling(
            Math.max(0, activeStart.eventAtMs - recording.captureAtMs) / 1_000,
          );
    const activeDurationSeconds =
      activeStart && endElapsedMs !== null
        ? frameRounding(Math.max(0, endElapsedMs - activeStart.elapsedMs) / 1_000)
        : null;
    return { attempt, trimStartSeconds, activeDurationSeconds };
  });
}

async function normalizeRecording(
  source: string,
  cut: RecordingCut,
  productionDirectory: string,
): Promise<string> {
  const segmentsDirectory = path.join(productionDirectory, "segments");
  await mkdir(segmentsDirectory, { recursive: true });
  const output = path.join(segmentsDirectory, path.basename(source));
  const metadataPath = `${output}.json`;
  const sourceInfo = await stat(source);
  const signature = {
    version: ASSEMBLY_VERSION,
    source,
    sourceBytes: sourceInfo.size,
    sourceMtimeMs: sourceInfo.mtimeMs,
    cut,
  };
  try {
    const existing = JSON.parse(await readFile(metadataPath, "utf8")) as {
      signature?: unknown;
    };
    await access(output);
    if (JSON.stringify(existing.signature) === JSON.stringify(signature)) return output;
  } catch {
    // Missing or stale normalized segment; regenerate it atomically.
  }

  const temporary = path.join(
    segmentsDirectory,
    `.${path.basename(source)}.${randomUUID()}.partial.mkv`,
  );
  const args = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
  ];
  if (cut.trimStartSeconds > 0) {
    args.push("-ss", cut.trimStartSeconds.toFixed(3));
  }
  args.push("-i", source);
  if (cut.activeDurationSeconds !== null) {
    args.push("-t", cut.activeDurationSeconds.toFixed(3));
  }
  args.push(
    "-map",
    "0:v:0",
    "-an",
    "-sn",
    "-vf",
    `fps=${FRAMES_PER_SECOND},setpts=N/(${FRAMES_PER_SECOND}*TB)`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-g",
    "60",
    "-keyint_min",
    "60",
    "-sc_threshold",
    "0",
    "-pix_fmt",
    "yuv420p",
    "-fps_mode",
    "cfr",
    "-f",
    "matroska",
    temporary,
  );
  try {
    await expectCommand("ffmpeg", args, { timeoutMs: 2 * 60 * 60_000 });
    await validateVideo(temporary);
    await rename(temporary, output);
    await durableJsonWrite(metadataPath, {
      normalizedAt: new Date().toISOString(),
      signature,
    });
    return output;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function validateVideo(filename: string): Promise<{
  durationSeconds: number;
  bytes: number;
}> {
  const probe = JSON.parse(
    (
      await expectCommand(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration,size",
          "-of",
          "json",
          filename,
        ],
        { timeoutMs: 60_000 },
      )
    ).toString("utf8"),
  ) as { format?: { duration?: string; size?: string } };
  const durationSeconds = Number(probe.format?.duration);
  const bytes = Number(probe.format?.size ?? (await stat(filename)).size);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || bytes <= 0) {
    throw new Error(`FFmpeg produced an invalid recording: ${filename}`);
  }
  return { durationSeconds, bytes };
}

async function readAuditEvents(filename: string): Promise<AuditEvent[]> {
  try {
    return (await readFile(filename, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as AuditEvent];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function recordingAttempt(filename: string): number {
  const match = /challenge-part-(\d+)\.mkv$/.exec(filename);
  if (!match?.[1]) throw new Error(`Invalid recording part name: ${filename}`);
  return Number(match[1]);
}

function nestedElapsedMs(data: Record<string, unknown> | null): number | null {
  const snapshot = objectValue(data?.snapshot);
  const time = objectValue(snapshot?.time);
  return numberValue(time?.elapsedMs);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function frameCeiling(seconds: number): number {
  return Math.ceil(seconds * FRAMES_PER_SECOND) / FRAMES_PER_SECOND;
}

function frameRounding(seconds: number): number {
  return Math.round(seconds * FRAMES_PER_SECOND) / FRAMES_PER_SECOND;
}

async function releaseRecordingPath(
  runDirectory: string,
  checkpointName: string,
): Promise<string> {
  const original = containedPath(runDirectory, checkpointName);
  const basename = path.basename(original);
  const candidates = [
    path.join(runDirectory, "recordings", "repaired-continuity", basename),
    path.join(runDirectory, "recordings", "repaired-timeline", basename),
    original,
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next non-destructive release override, then the original.
    }
  }
  throw new Error(`Recording part is missing: ${checkpointName}`);
}

function containedPath(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix)) {
    throw new Error(`Recording path escapes its run directory: ${relative}`);
  }
  return resolved;
}

function ffconcatEscape(filename: string): string {
  return filename.replaceAll("'", "'\\''");
}
