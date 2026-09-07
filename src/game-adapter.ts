import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { expectCommand, runCommand } from "./command.js";
import {
  type AllowedKey,
  type GameAdapter,
  type GameFrame,
} from "./types.js";

const keyNames: Record<AllowedKey, string> = {
  UP: "Up",
  DOWN: "Down",
  LEFT: "Left",
  RIGHT: "Right",
  Z: "z",
  R: "r",
  ENTER: "Return",
  ESCAPE: "Escape",
  SPACE: "space",
  TAB: "Tab",
  BACKSPACE: "BackSpace",
  DELETE: "Delete",
  HOME: "Home",
  END: "End",
  PAGEUP: "Page_Up",
  PAGEDOWN: "Page_Down",
  SHIFT: "Shift_L",
  CTRL: "Control_L",
  ALT: "Alt_L",
  A: "a",
  B: "b",
  C: "c",
  D: "d",
  E: "e",
  F: "f",
  G: "g",
  H: "h",
  I: "i",
  J: "j",
  K: "k",
  L: "l",
  M: "m",
  N: "n",
  O: "o",
  P: "p",
  Q: "q",
  S: "s",
  T: "t",
  U: "u",
  V: "v",
  W: "w",
  X: "x",
  Y: "y",
  "0": "0",
  "1": "1",
  "2": "2",
  "3": "3",
  "4": "4",
  "5": "5",
  "6": "6",
  "7": "7",
  "8": "8",
  "9": "9",
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",
};

const X11_KEY_HOLD_MS = 80;

interface PrivateGameWindow {
  id: number;
  title: string;
  app_id: string;
}

export class X11GameAdapter implements GameAdapter {
  readonly display: string;
  readonly frameDirectory: string;
  readonly keypressCommand: string;
  readonly titlePattern: RegExp;
  readonly compositorScreenshot: {
    command: string;
    arguments: string[];
    environment: NodeJS.ProcessEnv;
  } | undefined;
  #window: PrivateGameWindow | null = null;
  #captureCounter = 0;
  #serial: Promise<unknown> = Promise.resolve();

  constructor(options: {
    display: string;
    frameDirectory: string;
    keypressCommand: string;
    titlePattern?: RegExp;
    compositorScreenshot?: {
      command: string;
      arguments: string[];
      environment: NodeJS.ProcessEnv;
    };
  }) {
    this.display = options.display;
    this.frameDirectory = options.frameDirectory;
    this.keypressCommand = options.keypressCommand;
    this.titlePattern = options.titlePattern ?? /Patrick'?s Parabox|steam_app_1260520/i;
    this.compositorScreenshot = options.compositorScreenshot;
  }

  async discover(): Promise<{ windowId: number; title: string }> {
    const root = await expectCommand("xprop", [
      "-display",
      this.display,
      "-root",
      "_NET_CLIENT_LIST_STACKING",
      "_NET_ACTIVE_WINDOW",
    ]);
    const properties = root.toString("utf8");
    const ids = [...new Set([
      ...[...properties.matchAll(/0x[0-9a-f]+/gi)].map((match) =>
        Number.parseInt(match[0].slice(2), 16),
      ),
      ...[...properties.matchAll(/\b\d{4,}\b/g)].map((match) =>
        Number(match[0]),
      ),
    ])].filter((id) => Number.isSafeInteger(id) && id > 0).reverse();
    for (const id of ids) {
      const result = await runCommand("xprop", [
        "-display",
        this.display,
        "-id",
        String(id),
        "WM_NAME",
        "_NET_WM_NAME",
        "WM_CLASS",
      ]);
      if (result.code !== 0) continue;
      const properties = result.stdout.toString("utf8");
      if (!this.titlePattern.test(properties)) continue;
      const title =
        /(?:_NET_WM_NAME|WM_NAME)[^(]*\([^)]*\)\s*=\s*"([^"]+)"/.exec(
          properties,
        )?.[1] ?? "Steam game";
      this.#window = { id, title, app_id: "steam_game" };
      return { windowId: id, title };
    }
    throw new Error("Selected game window not found on the private X display");
  }

  async capture(): Promise<GameFrame> {
    return await this.#exclusive(async () => {
      const window = this.#window ?? (await this.#discoverWindow());
      await mkdir(this.frameDirectory, { recursive: true });
      const number = String(++this.#captureCounter).padStart(8, "0");
      const pngPath = path.join(this.frameDirectory, `${number}.png`);
      const jpegPath = path.join(this.frameDirectory, `${number}.jpg`);
      if (this.compositorScreenshot) {
        await expectCommand(
          this.compositorScreenshot.command,
          [...this.compositorScreenshot.arguments, pngPath],
          { env: this.compositorScreenshot.environment, timeoutMs: 10_000 },
        );
        await waitForStableFile(pngPath, 10_000);
        await expectCommand("ffmpeg", [
          "-nostdin", "-loglevel", "error", "-y",
          "-i", pngPath,
          "-frames:v", "1",
          "-vf", "scale='min(1920,iw)':-2",
          "-q:v", "3",
          jpegPath,
        ], { timeoutMs: 10_000 });
        await rm(pngPath, { force: true });
      } else {
        await expectCommand("ffmpeg", [
          "-nostdin", "-loglevel", "error", "-y",
          "-f", "x11grab",
          "-draw_mouse", "0",
          "-framerate", "30",
          "-window_id", String(window.id),
          "-i", `${this.display}.0`,
          "-frames:v", "1",
          "-vf", "scale='min(1920,iw)':-2",
          "-q:v", "3",
          jpegPath,
        ], { timeoutMs: 10_000 });
      }
      const data = await readFile(jpegPath);
      return {
        data,
        mimeType: "image/jpeg",
        sha256: createHash("sha256").update(data).digest("hex"),
        capturedAt: new Date().toISOString(),
      };
    });
  }

  async waitForVisibleFrame(
    timeoutMs: number,
    cancelled: () => boolean = () => false,
  ): Promise<{ frame: GameFrame; filename: string }> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline && !cancelled()) {
      try {
        const frame = await this.capture();
        const filename = path.join(
          this.frameDirectory,
          `${String(this.#captureCounter).padStart(8, "0")}.jpg`,
        );
        if (await frameHasVisiblePixels(filename)) return { frame, filename };
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (cancelled()) throw new Error("Game startup cancelled");
    throw lastError instanceof Error
      ? lastError
      : new Error("Game did not present a visible frame before the timeout");
  }

  latestFrameFilename(): string {
    return path.join(
      this.frameDirectory,
      `${String(this.#captureCounter).padStart(8, "0")}.jpg`,
    );
  }

  async press(
    keys: AllowedKey[],
    options: { intervalMs: number; settleMs: number },
  ): Promise<void> {
    await this.#exclusive(async () => {
      const window = this.#window ?? (await this.#discoverWindow());
      await expectCommand(
        this.keypressCommand,
        [
          this.display,
          String(window.id),
          String(options.intervalMs),
          String(options.settleMs),
          String(X11_KEY_HOLD_MS),
          ...keys.map((key) => keyNames[key]),
        ],
        {
          timeoutMs: Math.max(
            15_000,
            keys.length * (options.intervalMs + X11_KEY_HOLD_MS) +
              options.settleMs +
              5_000,
          ),
        },
      );
    });
  }

  async typeText(
    text: string,
    options: { intervalMs: number; settleMs: number },
  ): Promise<void> {
    if (Buffer.byteLength(text, "utf8") > 4_096 || /[^\x09\x0a\x20-\x7e]/.test(text)) {
      throw new Error("typeText accepts at most 4096 printable ASCII characters");
    }
    await this.#input([
      "type",
      String(options.intervalMs),
      String(options.settleMs),
      text,
    ], Math.max(15_000, text.length * (options.intervalMs + 30) + options.settleMs + 5_000));
  }

  async movePointer(x: number, y: number): Promise<void> {
    await this.#input(["move", String(x), String(y)]);
  }

  async clickPointer(
    x: number,
    y: number,
    button: "left" | "middle" | "right",
    count: number,
  ): Promise<void> {
    const buttonNumber = button === "left" ? 1 : button === "middle" ? 2 : 3;
    await this.#input(["click", String(x), String(y), String(buttonNumber), String(count)]);
  }

  async dragPointer(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    durationMs: number,
  ): Promise<void> {
    await this.#input([
      "drag",
      String(fromX),
      String(fromY),
      String(toX),
      String(toY),
      String(durationMs),
    ], Math.max(15_000, durationMs + 5_000));
  }

  async scrollPointer(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
  ): Promise<void> {
    await this.#input([
      "scroll",
      String(x),
      String(y),
      String(deltaX),
      String(deltaY),
    ]);
  }

  async close(): Promise<void> {
    this.#window = null;
  }

  async #discoverWindow(): Promise<PrivateGameWindow> {
    await this.discover();
    if (!this.#window) throw new Error("Game window discovery failed");
    return this.#window;
  }

  async #input(args: string[], timeoutMs = 15_000): Promise<void> {
    await this.#exclusive(async () => {
      const window = this.#window ?? (await this.#discoverWindow());
      await expectCommand(
        this.keypressCommand,
        [this.display, String(window.id), ...args],
        { timeoutMs },
      );
    });
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#serial.then(operation, operation);
    this.#serial = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

async function waitForStableFile(filename: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previousSize = -1;
  while (Date.now() < deadline) {
    const size = await stat(filename).then((value) => value.size).catch(() => -1);
    if (size > 0 && size === previousSize) return;
    previousSize = size;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for compositor screenshot: ${filename}`);
}

async function frameHasVisiblePixels(filename: string): Promise<boolean> {
  const result = await runCommand("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "info",
    "-i", filename,
    "-vf", "signalstats,metadata=print",
    "-frames:v", "1",
    "-f", "null", "-",
  ], { timeoutMs: 10_000 });
  const output = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`;
  const maximum = Number(/lavfi\.signalstats\.YMAX=([\d.]+)/.exec(output)?.[1]);
  return result.code === 0 && Number.isFinite(maximum) && maximum > 1;
}

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export class MockGameAdapter implements GameAdapter {
  presses: AllowedKey[][] = [];

  async discover() {
    return { windowId: 1, title: "Steam game (mock)" };
  }

  async capture(): Promise<GameFrame> {
    return {
      data: pixel,
      mimeType: "image/png",
      width: 1,
      height: 1,
      sha256: createHash("sha256").update(pixel).digest("hex"),
      capturedAt: new Date().toISOString(),
    };
  }

  async press(
    keys: AllowedKey[],
    _options: { intervalMs: number; settleMs: number },
  ): Promise<void> {
    this.presses.push([...keys]);
  }

  async close(): Promise<void> {}
}
