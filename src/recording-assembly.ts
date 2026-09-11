import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AuditLog } from "./audit-log.js";
import { expectCommand } from "./command.js";
import { recoverRecordingPairs } from "./recording-pair.js";
import {
  CheckpointStore,
  durableJsonWrite,
  processMatches,
  readActiveRun,
  type RunCheckpoint,
} from "./run-checkpoint.js";

const ASSEMBLY_VERSION = 6;
const FRAMES_PER_SECOND = 30;

export interface AuditEvent {
  at: string;
  type: string;
  data: unknown;
}

export interface RecordingCut {
  attempt: number;
  trimStartSeconds: number;
  activeDurationSeconds: number | null;
}

export interface OmittedRecordingPart {
  attempt: number;
  filename: string;
  reason: "unplayable" | "empty-cut";
}

export interface RecordingAssembly {
  output: string;
  complete: boolean;
  durationSeconds: number;
  bytes: number;
  sources: string[];
  cuts: RecordingCut[];
  activeElapsedMs: number | null;
  omittedParts: OmittedRecordingPart[];
  trimmedResumeSeconds: number;
  omittedOpenRecording: string | null;
}

export function sealedRecordingNames(
  checkpoint: RunCheckpoint,
  events: AuditEvent[] = [],
): {
  names: string[];
  omittedOpenRecording: string | null;
} {
  const names = [...checkpoint.recordings];
  if (checkpoint.recordingPairs !== undefined) {
    const confirmed = confirmedRecordingNames(events);
    return {
      names: names.filter((name) => confirmed.has(name)),
      omittedOpenRecording: null,
    };
  }
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
  const events = await readAuditEvents(path.join(runDirectory, "events.jsonl"));
  const selection = sealedRecordingNames(checkpoint, events);
  if (selection.names.length === 0) {
    throw new Error("No sealed recording parts are available yet");
  }

  const sources: string[] = [];
  const cuts: RecordingCut[] = [];
  const omittedParts: OmittedRecordingPart[] = [];
  const candidateCuts = recordingCuts(events, selection.names);
  for (let index = 0; index < selection.names.length; index += 1) {
    const name = selection.names[index];
    const cut = candidateCuts[index];
    if (!name || !cut) throw new Error("Recording assembly plan is incomplete");
    let source: string;
    let sourceVideo: Awaited<ReturnType<typeof validateVideo>>;
    try {
      source = await releaseRecordingPath(runDirectory, name);
      sourceVideo = await validateVideo(source);
    } catch {
      omittedParts.push({ attempt: cut.attempt, filename: name, reason: "unplayable" });
      continue;
    }
    const missingActiveBoundary = checkpoint.recordingPairs !== undefined &&
      !hasActiveBoundary(events, cut.attempt);
    if (missingActiveBoundary || !cutContainsFrame(cut, sourceVideo.durationSeconds)) {
      omittedParts.push({ attempt: cut.attempt, filename: name, reason: "empty-cut" });
      continue;
    }
    sources.push(source);
    cuts.push(cut);
  }
  if (sources.length === 0) {
    throw new Error("No playable sealed recording parts are available yet");
  }
  const activeElapsedMs = exactActiveElapsedMs(events, cuts);

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
    method: "untrimmed-sealed-part-concat",
    output,
    complete: checkpoint.phase === "completed",
    sources,
    cuts,
    activeElapsedMs,
    omittedParts,
  };
  const metadataPath = path.join(productionDirectory, "assembly.json");
  try {
    const existing = JSON.parse(await readFile(metadataPath, "utf8")) as {
      signature?: unknown;
      result?: RecordingAssembly;
    };
    await validateVideo(output);
    if (
      existing.result &&
      JSON.stringify(existing.signature) === JSON.stringify(assemblySignature)
    ) {
      return {
        ...existing.result,
        sources,
        cuts,
        activeElapsedMs,
        omittedParts,
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
        "-map",
        "0:a:0?",
        "-sn",
        "-c:v",
        "copy",
        "-c:a",
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
      activeElapsedMs,
      omittedParts,
      trimmedResumeSeconds: cuts.reduce(
        (total, cut) => total + cut.trimStartSeconds,
        0,
      ),
      omittedOpenRecording: selection.omittedOpenRecording,
    };
    await durableJsonWrite(metadataPath, {
      version: ASSEMBLY_VERSION,
      method: "untrimmed-sealed-part-concat",
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

export interface RecordingTimingReconciliation {
  beforeElapsedMs: number;
  afterElapsedMs: number;
  omittedAttempts: number[];
  reason: string;
}

export function recordingTimingReconciliation(
  checkpoint: RunCheckpoint,
  assembly: RecordingAssembly,
): RecordingTimingReconciliation | null {
  if (!checkpoint.options.record || checkpoint.recordingPairs === undefined) return null;
  if (
    assembly.activeElapsedMs === null ||
    !Number.isFinite(assembly.activeElapsedMs) ||
    assembly.activeElapsedMs < 0 ||
    assembly.activeElapsedMs >= checkpoint.elapsedMs
  ) {
    return null;
  }
  if (assembly.omittedParts.some((part) => part.reason === "unplayable")) return null;
  const emptyResumedAttempts = assembly.omittedParts
    .filter((part) => part.reason === "empty-cut" && part.attempt > 1)
    .map((part) => part.attempt);
  if (emptyResumedAttempts.length === 0) return null;

  const accountedAttempts = new Set([
    ...assembly.cuts.map((cut) => cut.attempt),
    ...assembly.omittedParts.map((part) => part.attempt),
  ]);
  let checkpointAttempts: number[];
  try {
    checkpointAttempts = checkpoint.recordings.map(recordingAttempt);
  } catch {
    return null;
  }
  if (checkpointAttempts.some((attempt) => !accountedAttempts.has(attempt))) return null;

  return {
    beforeElapsedMs: checkpoint.elapsedMs,
    afterElapsedMs: assembly.activeElapsedMs,
    omittedAttempts: [...new Set(emptyResumedAttempts)].sort((left, right) => left - right),
    reason: "Excluded resumed recording cuts that contain no playable frame",
  };
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
          const checkpoint = (await CheckpointStore.load(assemblyTarget)).snapshot();
          if (checkpoint.options.record && checkpoint.recordingPairs) {
            const hasLiveRecorder =
              (checkpoint.phase === "starting" || checkpoint.phase === "running") &&
              checkpoint.pid !== null &&
              processMatches(checkpoint.pid, checkpoint.pidStartTicks);
            const recovered = await recoverRecordingPairs(
              assemblyTarget,
              checkpoint.recordingPairs,
              {
                beforeAttempt: hasLiveRecorder
                  ? checkpoint.attempt
                  : checkpoint.attempt + 1,
                knownRecordings: checkpoint.recordings,
              },
            );
            if (recovered.warnings.length > 0) {
              const audit = new AuditLog(assemblyTarget);
              for (const warning of recovered.warnings) {
                await audit.append("recording.recovery.warning", warning);
              }
            }
          }
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
  void events;
  return recordingNames.map((name) => ({
    attempt: recordingAttempt(name),
    trimStartSeconds: 0,
    activeDurationSeconds: null,
  }));
}

function exactActiveElapsedMs(events: AuditEvent[], cuts: RecordingCut[]): number | null {
  const activeStarts = new Map<number, number>();
  const activeEnds = new Map<number, number>();
  for (const event of events) {
    const data = objectValue(event.data);
    const attempt = numberValue(data?.attempt);
    if (attempt === null) continue;
    if (event.type === "challenge.started" || event.type === "challenge.resumed") {
      const elapsedMs = numberValue(data?.activeStartedElapsedMs) ?? nestedElapsedMs(data);
      if (elapsedMs !== null) activeStarts.set(attempt, elapsedMs);
    }
    if (event.type === "attempt.finished") {
      const elapsedMs = numberValue(data?.activeEndedElapsedMs) ?? nestedElapsedMs(data);
      if (elapsedMs !== null) activeEnds.set(attempt, elapsedMs);
    }
  }
  const sortedStarts = [...activeStarts.entries()].sort(([left], [right]) => left - right);
  let total = 0;
  for (const cut of cuts) {
    const startElapsedMs = cut.attempt === 1 ? 0 : activeStarts.get(cut.attempt);
    const endElapsedMs = activeEnds.get(cut.attempt) ??
      sortedStarts.find(([attempt]) => attempt > cut.attempt)?.[1];
    if (startElapsedMs === undefined || endElapsedMs === undefined) return null;
    total += Math.max(0, endElapsedMs - startElapsedMs);
  }
  return total;
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
    if (JSON.stringify(existing.signature) === JSON.stringify(signature)) {
      await validateVideo(output);
      return output;
    }
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
  args.push("-i", source);
  const sourceMedia = await validateVideo(source);
  if (!sourceMedia.hasAudio) {
    args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  }
  args.push(
    "-map",
    "0:v:0",
    "-map",
    sourceMedia.hasAudio ? "0:a:0" : "1:a:0",
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
    "-af",
    "apad",
    "-shortest",
    "-c:a",
    "libopus",
    "-b:a",
    "160k",
    "-ar",
    "48000",
    "-ac",
    "2",
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
  hasAudio: boolean;
}> {
  const probe = JSON.parse(
    (
      await expectCommand(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type,width,height:format=duration,size",
          "-of",
          "json",
          filename,
        ],
        { timeoutMs: 60_000 },
      )
    ).toString("utf8"),
  ) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
    format?: { duration?: string; size?: string };
  };
  const durationSeconds = Number(probe.format?.duration);
  const bytes = Number(probe.format?.size ?? (await stat(filename)).size);
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  if (
    !video ||
    !Number.isFinite(video.width) ||
    Number(video.width) <= 0 ||
    !Number.isFinite(video.height) ||
    Number(video.height) <= 0 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    bytes <= 0
  ) {
    throw new Error(`FFmpeg produced an invalid recording: ${filename}`);
  }
  return {
    durationSeconds,
    bytes,
    hasAudio: probe.streams?.some((stream) => stream.codec_type === "audio") ?? false,
  };
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

function confirmedRecordingNames(events: AuditEvent[]): Set<string> {
  const confirmed = new Set<string>();
  for (const event of events) {
    const data = objectValue(event.data);
    if (event.type === "recording.sealed") {
      const filename = stringValue(data?.filename);
      if (filename) confirmed.add(filename);
    }
    if (event.type === "recording.recovered" && Array.isArray(data?.recordings)) {
      for (const value of data.recordings) {
        const filename = stringValue(value);
        if (filename) confirmed.add(filename);
      }
    }
  }
  return confirmed;
}

function cutContainsFrame(cut: RecordingCut, sourceDurationSeconds: number): boolean {
  const availableSeconds = sourceDurationSeconds - cut.trimStartSeconds;
  const selectedSeconds = cut.activeDurationSeconds === null
    ? availableSeconds
    : Math.min(availableSeconds, cut.activeDurationSeconds);
  return selectedSeconds >= 1 / FRAMES_PER_SECOND;
}

function hasActiveBoundary(events: AuditEvent[], attempt: number): boolean {
  return events.some((event) => {
    if (event.type !== "challenge.started" && event.type !== "challenge.resumed") {
      return false;
    }
    return numberValue(objectValue(event.data)?.attempt) === attempt;
  });
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
