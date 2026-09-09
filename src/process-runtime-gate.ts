import { readdir, readFile } from "node:fs/promises";

export const GAME_RUNTIME_MARKER = "ASTRA_GAME_RUNTIME_ID";

export interface ProcessRuntimeGate {
  readonly environment: NodeJS.ProcessEnv;
  readonly frozen: boolean;
  readonly processIds: readonly number[];
  freeze(): Promise<readonly number[]>;
  thaw(): Promise<readonly number[]>;
}

export function createProcessRuntimeGate(runtimeId: string): ProcessRuntimeGate {
  const marker = sanitizeMarker(runtimeId);
  const stopped = new Set<number>();
  let frozen = false;

  const discover = async () => await markedProcessIds(marker);
  const signal = async (name: NodeJS.Signals): Promise<number[]> => {
    const candidates = [...new Set([...stopped, ...await discover()])]
      .sort((left, right) => name === "SIGSTOP" ? right - left : left - right);
    const signalled: number[] = [];
    for (const pid of candidates) {
      try {
        process.kill(pid, name);
        signalled.push(pid);
        if (name === "SIGSTOP") stopped.add(pid);
      } catch {
        stopped.delete(pid);
      }
    }
    return signalled;
  };

  return {
    environment: { [GAME_RUNTIME_MARKER]: marker },
    get frozen() {
      return frozen;
    },
    get processIds() {
      return [...stopped].sort((left, right) => left - right);
    },
    freeze: async () => {
      if (frozen) return [...stopped];
      const first = await signal("SIGSTOP");
      if (first.length === 0) {
        throw new Error("No marked game process is available to freeze");
      }
      // A launcher may fork between discovery and SIGSTOP. Once its marked
      // parents are stopped, this second pass closes that small race.
      await delay(25);
      await signal("SIGSTOP");
      frozen = true;
      return [...stopped].sort((left, right) => left - right);
    },
    thaw: async () => {
      const resumed = await signal("SIGCONT");
      stopped.clear();
      frozen = false;
      return resumed.sort((left, right) => left - right);
    },
  };
}

export async function markedProcessIds(marker: string): Promise<number[]> {
  const exact = `${GAME_RUNTIME_MARKER}=${sanitizeMarker(marker)}`;
  const entries = await readdir("/proc", { withFileTypes: true });
  const processes: Array<{ pid: number; parentPid: number; marked: boolean }> = [];
  await Promise.all(entries.flatMap((entry) => {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) return [];
    const pid = Number(entry.name);
    if (pid === process.pid) return [];
    return [Promise.all([
      readFile(`/proc/${entry.name}/environ`),
      readFile(`/proc/${entry.name}/status`, "utf8"),
    ]).then(([environment, status]) => {
      processes.push({
        pid,
        parentPid: Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0),
        marked: environment.toString("utf8").split("\0").includes(exact),
      });
    }).catch(() => undefined)];
  }));
  const matches = new Set(
    processes.filter((candidate) => candidate.marked).map((candidate) => candidate.pid),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of processes) {
      if (!matches.has(candidate.pid) && matches.has(candidate.parentPid)) {
        matches.add(candidate.pid);
        changed = true;
      }
    }
  }
  return [...matches].sort((left, right) => left - right);
}

function sanitizeMarker(runtimeId: string): string {
  const marker = runtimeId.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 160);
  if (!marker) throw new Error("Runtime id cannot be converted to a process marker");
  return marker;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
