import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class RolloutTailer {
  readonly threadId: string;
  readonly sessionsRoots: string[];
  readonly sinceMs: number;
  #stopped = false;
  #filenames: string[] = [];
  #offsets = new Map<string, number>();
  #remainders = new Map<string, string>();
  #lastDiscoveryMs = 0;

  constructor(
    threadId: string,
    sessionsRoot: string | string[] = path.join(os.homedir(), ".codex/sessions"),
    sinceMs = 0,
  ) {
    this.threadId = threadId;
    this.sessionsRoots = [...new Set(
      (Array.isArray(sessionsRoot) ? sessionsRoot : [sessionsRoot])
        .map((root) => path.resolve(root)),
    )];
    this.sinceMs = sinceMs;
  }

  stop(): void {
    this.#stopped = true;
  }

  async follow(onEvent: (event: unknown, raw: string) => Promise<void>): Promise<void> {
    while (!this.#stopped) {
      if (this.#filenames.length === 0 || Date.now() - this.#lastDiscoveryMs >= 2_000) {
        this.#filenames = (await Promise.all(
          this.sessionsRoots.map((root) => findAllByName(root, this.threadId)),
        )).flat();
        this.#lastDiscoveryMs = Date.now();
      }
      const selected = await newestFile(this.#filenames);
      if (!selected) {
        await delay(200);
        continue;
      }
      const offset = this.#offsets.get(selected.filename) ?? 0;
      if (selected.size > offset) {
        const handle = await open(selected.filename, "r");
        try {
          const length = selected.size - offset;
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          this.#offsets.set(selected.filename, offset + bytesRead);
          const lines = (
            (this.#remainders.get(selected.filename) ?? "") +
            buffer.subarray(0, bytesRead).toString("utf8")
          ).split("\n");
          this.#remainders.set(selected.filename, lines.pop() ?? "");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line) as Record<string, unknown>;
              const timestamp =
                typeof event.timestamp === "string"
                  ? Date.parse(event.timestamp)
                  : Number.NaN;
              if (Number.isFinite(timestamp) && timestamp < this.sinceMs) {
                continue;
              }
              await onEvent(event, line);
            } catch {
              // An incomplete or unknown event does not stop telemetry.
            }
          }
        } finally {
          await handle.close();
        }
      }
      await delay(200);
    }
  }
}

async function findAllByName(root: string, needle: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const entry of entries) {
    const filename = path.join(root, entry.name);
    if (entry.isFile() && entry.name.includes(needle)) matches.push(filename);
    if (entry.isDirectory()) {
      matches.push(...await findAllByName(filename, needle));
    }
  }
  return matches;
}

async function newestFile(
  filenames: string[],
): Promise<{ filename: string; size: number } | null> {
  const candidates = await Promise.all(
    filenames.map(async (filename) => {
      try {
        const info = await stat(filename);
        return { filename, size: info.size, mtimeMs: info.mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  return candidates
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((left, right) =>
      right.mtimeMs - left.mtimeMs || right.size - left.size ||
      left.filename.localeCompare(right.filename)
    )[0] ?? null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
