export const TARGET_LEVELS = 364;

export type ChallengeStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface LevelProgress {
  total: number;
  unlocked: number;
  completed: number;
}

export interface TimeSnapshot {
  status: ChallengeStatus;
  elapsedMs: number;
  startedAt: string | null;
  endedAt: string | null;
  sampledAt: string;
}

export interface TokenSnapshot extends TokenUsage {
  sampledAt: string;
  source: "none" | "rollout" | "exec";
}

export interface ChallengeSnapshot {
  runId: string | null;
  model: string;
  goal: string;
  game: { appId: string; name: string } | null;
  attempt: number;
  status: ChallengeStatus;
  targetLevels: number;
  progress: LevelProgress;
  time: TimeSnapshot;
  tokens: TokenSnapshot;
  failure: string | null;
  completion: { summary: string; declaredAt: string } | null;
}

export interface GameFrame {
  data: Buffer;
  mimeType: "image/png" | "image/jpeg";
  width?: number;
  height?: number;
  sha256: string;
  capturedAt: string;
}

export const allowedKeys = [
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT",
  "Z",
  "R",
  "ENTER",
  "ESCAPE",
  "SPACE",
  "TAB",
  "BACKSPACE",
  "DELETE",
  "HOME",
  "END",
  "PAGEUP",
  "PAGEDOWN",
  "SHIFT",
  "CTRL",
  "ALT",
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
] as const;

export type AllowedKey = (typeof allowedKeys)[number];

export interface GameAdapter {
  discover(): Promise<{ windowId: number; title: string }>;
  capture(): Promise<GameFrame>;
  press(
    keys: AllowedKey[],
    options: { intervalMs: number; settleMs: number },
  ): Promise<void>;
  typeText?(text: string, options: { intervalMs: number; settleMs: number }): Promise<void>;
  movePointer?(x: number, y: number): Promise<void>;
  clickPointer?(
    x: number,
    y: number,
    button: "left" | "middle" | "right",
    count: number,
  ): Promise<void>;
  dragPointer?(fromX: number, fromY: number, toX: number, toY: number, durationMs: number): Promise<void>;
  scrollPointer?(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  close?(): Promise<void>;
}
