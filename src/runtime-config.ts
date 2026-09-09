import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { durableJsonWrite, type PersistedRunOptions } from "./run-checkpoint.js";

export const RUNTIME_CONFIG_REQUEST = "runtime-config-request.json";
export const RUNTIME_CONFIG_ACK = "runtime-config-ack.json";
export const RUNTIME_MEDIA_STATE = "runtime-media-state.json";
export const RUNTIME_CONTROL_STATE = "runtime-control-state.json";
const RUNTIME_CONFIG_DIRECTORY = "runtime-configuration";

export type MutableRuntimeConfiguration = Pick<
  PersistedRunOptions,
  | "model"
  | "reasoningEffort"
  | "record"
  | "virtualCamera"
  | "virtualCameraDevice"
  | "quotaWaitMs"
  | "accountPolicies"
  | "launchMode"
  | "offlineMode"
  | "goal"
  | "webSearchEnabled"
  | "browserUseEnabled"
  | "toolCreationGuidance"
>;

export interface RuntimeConfigRequest {
  version: 1;
  id: string;
  requestedAt: string;
  patch: Partial<MutableRuntimeConfiguration>;
}

export interface RuntimeConfigAck {
  version: 1;
  id: string;
  appliedAt: string;
  appliedFields: string[];
  deferredFields: string[];
  codexRestarted: boolean;
  error: string | null;
}

export interface RuntimeMediaState {
  version: 1;
  updatedAt: string;
  recordingActive: boolean;
  recordingError: string | null;
  virtualCameraActive: boolean;
  virtualCameraDevice: string | null;
  virtualCameraError: string | null;
  virtualMicrophoneActive?: boolean;
  virtualMicrophoneName?: string | null;
  virtualMicrophoneError?: string | null;
  lastError?: string | null;
}

export interface RuntimeControlState {
  version: 1;
  updatedAt: string;
  operatorPaused: boolean;
}

export function runtimeConfigRequestPath(
  runDirectory: string,
  requestId?: string,
): string {
  return requestId
    ? path.join(runtimeConfigQueuePath(runDirectory), "requests", `${requestId}.json`)
    : path.join(runDirectory, RUNTIME_CONFIG_REQUEST);
}

export function runtimeConfigAckPath(
  runDirectory: string,
  requestId?: string,
): string {
  return requestId
    ? path.join(runtimeConfigQueuePath(runDirectory), "acks", `${requestId}.json`)
    : path.join(runDirectory, RUNTIME_CONFIG_ACK);
}

export function runtimeMediaStatePath(runDirectory: string): string {
  return path.join(runDirectory, RUNTIME_MEDIA_STATE);
}

export function runtimeControlStatePath(runDirectory: string): string {
  return path.join(runDirectory, RUNTIME_CONTROL_STATE);
}

export async function writeRuntimeControlState(
  runDirectory: string,
  operatorPaused: boolean,
): Promise<void> {
  await durableJsonWrite(runtimeControlStatePath(runDirectory), {
    version: 1,
    updatedAt: new Date().toISOString(),
    operatorPaused,
  } satisfies RuntimeControlState);
}

export async function readRuntimeControlState(
  runDirectory: string,
): Promise<RuntimeControlState | null> {
  return await readVersioned<RuntimeControlState>(runtimeControlStatePath(runDirectory));
}

export async function writeRuntimeConfigRequest(
  runDirectory: string,
  request: RuntimeConfigRequest,
): Promise<void> {
  await mkdir(path.join(runtimeConfigQueuePath(runDirectory), "requests"), {
    recursive: true,
  });
  await durableJsonWrite(runtimeConfigRequestPath(runDirectory, request.id), request);
}

export async function readRuntimeConfigRequest(
  runDirectory: string,
  requestId?: string,
): Promise<RuntimeConfigRequest | null> {
  if (requestId) {
    return await readVersioned<RuntimeConfigRequest>(
      runtimeConfigRequestPath(runDirectory, requestId),
    );
  }
  const requestDirectory = path.join(runtimeConfigQueuePath(runDirectory), "requests");
  const requests = await readdir(requestDirectory).catch(() => []);
  const queued: RuntimeConfigRequest[] = [];
  for (const name of requests.filter((entry) => entry.endsWith(".json"))) {
    const request = await readVersioned<RuntimeConfigRequest>(
      path.join(requestDirectory, name),
    );
    if (!request || await readRuntimeConfigAck(runDirectory, request.id)) continue;
    queued.push(request);
  }
  queued.sort((left, right) =>
    Date.parse(left.requestedAt) - Date.parse(right.requestedAt) ||
    left.id.localeCompare(right.id)
  );
  if (queued[0]) return queued[0];

  const legacy = await readVersioned<RuntimeConfigRequest>(
    runtimeConfigRequestPath(runDirectory),
  );
  if (!legacy) return null;
  const legacyAck = await readVersioned<RuntimeConfigAck>(
    runtimeConfigAckPath(runDirectory),
  );
  return legacyAck?.id === legacy.id ? null : legacy;
}

export async function writeRuntimeConfigAck(
  runDirectory: string,
  ack: RuntimeConfigAck,
): Promise<void> {
  await mkdir(path.join(runtimeConfigQueuePath(runDirectory), "acks"), {
    recursive: true,
  });
  await durableJsonWrite(runtimeConfigAckPath(runDirectory, ack.id), ack);
}

export async function readRuntimeConfigAck(
  runDirectory: string,
  requestId?: string,
): Promise<RuntimeConfigAck | null> {
  if (requestId) {
    const queued = await readVersioned<RuntimeConfigAck>(
      runtimeConfigAckPath(runDirectory, requestId),
    );
    if (queued) return queued;
    const legacy = await readVersioned<RuntimeConfigAck>(
      runtimeConfigAckPath(runDirectory),
    );
    return legacy?.id === requestId ? legacy : null;
  }
  return await readVersioned<RuntimeConfigAck>(runtimeConfigAckPath(runDirectory));
}

export async function writeRuntimeMediaState(
  runDirectory: string,
  state: RuntimeMediaState,
): Promise<void> {
  await durableJsonWrite(runtimeMediaStatePath(runDirectory), state);
}

export async function readRuntimeMediaState(
  runDirectory: string,
): Promise<RuntimeMediaState | null> {
  return await readVersioned<RuntimeMediaState>(runtimeMediaStatePath(runDirectory));
}

function runtimeConfigQueuePath(runDirectory: string): string {
  return path.join(runDirectory, RUNTIME_CONFIG_DIRECTORY);
}

async function readVersioned<T extends { version: 1 }>(filename: string): Promise<T | null> {
  try {
    const value = JSON.parse(await readFile(filename, "utf8")) as T;
    return value.version === 1 ? value : null;
  } catch {
    return null;
  }
}
