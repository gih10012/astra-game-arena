# Astra Game Arena

A reproducible, screen-only arena for testing whether a Codex model can complete a natural-language goal in a locally installed Steam game. Patrick's Parabox (364 official levels) is the first fully verified adapter; other installed games use the same best-effort private desktop and input boundary.

The model receives one neutral task sentence, rendered game frames, keyboard actions, and two self-inspection tools for elapsed time and token usage. It receives no walkthrough, level data, or save contents. Native web search and network browsers are disabled; normal Codex capabilities such as Shell, skills, plugins, memory, and sub-agents remain available.

> This repository contains no game binary, game assets, save data, or recorded footage. A legitimately purchased Steam copy of Patrick's Parabox is required.

## Why this architecture

The native game window remains the sole source of truth. It runs inside Cage's headless wlroots compositor and private Xwayland display. A local MCP bridge requests compositor screenshots and sends isolated mouse/keyboard events. A separate Chrome instance renders the director dashboard in another private Xvfb display. Neither window is mapped to the operator's physical desktop.

```text
                    ┌─ observe_screen / computer-use ─┐
Codex model (Codex) ┤                              ├─ Native game in Cage headless Xwayland
                    └─ challenge_time / tokens ───┤
                                                  │
Codex JSONL + rollout usage ── Arena controller ──┼─ Director dashboard
Game save (referee only) ─────────────────────────┘
                                                  │
Cage screencopy + dashboard Xvfb ── FFmpeg → continuous CFR parts
```

The browser is a read-only control/monitoring plane, never a game reimplementation. It lets the operator configure a run and view the unmodified native game beside an exact Codex transcript. It is always served on loopback by the watchdog; no physical browser is opened by default.

## Formal layout sample

Generate a fresh six-second 1920×1080 sample from the installed game without using model tokens:

```bash
node dist/src/cli.js smoke-headless
```

The command writes a playable `recordings/challenge-part-0001.mkv` under `.arena/`, with the native game on the left and the compact director dashboard on the right. It also verifies 30 FPS, changing native pixels, and save restoration.

## Requirements

The current implementation targets Linux with:

- Node.js 22+
- Codex CLI with `gpt-6-astra`
- Patrick's Parabox (Steam app `1260520`)
- Cage with its headless wlroots backend and Xwayland
- Xvfb, `xprop`, `wlr-randr`, `grim`, FFmpeg, Steam, Google Chrome, a C compiler, and X11/XTest headers
- optional: `v4l2loopback` for presenting the live production layout as a virtual camera

On Arch Linux the additional runtime packages are:

```bash
sudo pacman -S cage xorg-server-xvfb xorg-xprop grim wf-recorder libxtst
```

Install and verify:

```bash
npm install
npm run build
npm run doctor
```

By default, the harness uses `~/.codex-official` when that directory contains `auth.json`, then falls back to the normal Codex home. Override it with `--codex-home PATH` or `ASTRA_CODEX_HOME`. Credentials are never copied into run artifacts.

If two or more separately authenticated homes exist under `~/.codex-game-arena-accounts/<label>/auth.json`, the runner enables its resumable account pool. The legacy `~/.codex-parabox-accounts` location is still discovered automatically so existing credentials are not lost. The same Codex thread is synchronized through `codex-proxy` when accounts rotate. The control page lets you enable accounts and set independent five-hour and weekly reserve percentages. The scheduler prefers a recently reset account, proactively snapshots before switching, and waits when every enabled account is below its configured reserve. `runs/<run-id>/account-pool.json` records only scheduling telemetry; authentication files remain outside the repository. Multi-account use is disclosed in the audit trail.

Validate authentication and the arena MCP tools with a small, non-challenge turn before touching saves:

```bash
node dist/src/cli.js smoke-model
```

Preview the director dashboard without touching the game or using model tokens:

```bash
npm run demo
```

The command prints a loopback URL and does not open a window. Use `npm run demo -- --browser` only when you explicitly want a physical monitoring window. Test the complete hidden game, screenshot, keyboard, dashboard, recorder, and cleanup path without using model tokens:

```bash
node dist/src/cli.js smoke-headless
```

## Formal run

Before a recorded run, disable Steam Cloud for Patrick's Parabox and close Steam completely. The harness refuses to start while another Steam process exists, preventing Steam's single-instance forwarding from placing the game on the physical desktop. It temporarily moves existing `save*.txt` files into the run's recoverable backup, starts with no save slots, archives the challenge save at the end, and restores the originals.

```bash
npm run build
node dist/src/cli.js service install
node dist/src/cli.js service status
node dist/src/cli.js run
```

Install the per-user watchdog once before the first long run. `run` then
durably queues the challenge with that watchdog and returns. Once it prints
`You may close this terminal now`, closing the terminal is safe. The watchdog
owns the first attempt as well as every quota or reboot resume. The dashboard
is available continuously at `http://127.0.0.1:4317` as soon as the watchdog is installed;
follow startup and resume logs with:

```bash
journalctl --user -u astra-game-arena-watchdog.service -f
```

The service starts with the user systemd manager and watches the single active run. During a quota wait the recorder and active timer stop, while the hidden game/controller process remains alive; the same in-memory game state and Codex thread resume when the reset deadline passes. A normal OS suspend freezes that process and continues from the same state on wake. A reboot cannot preserve Wine/GPU RAM, so the watchdog relaunches from the durable game save and resumes the persisted Codex `thread_id`. The next recording part first holds the last compositor snapshot while the title screen is handled behind it, then switches to the restored live frame; the title page therefore appears only in the initial part. If the deadline passed while asleep or powered off, the first wake/boot poll resumes immediately. The watchdog does not wait for niri or another physical compositor.

If Codex reports a quota/rate-limit error, the runner uses the exhausted window's reported reset time plus a one-minute safety margin. Five hours is only the fallback when Codex provides no usable reset timestamp; customize that fallback with `--quota-wait-hours`. While discharging at 3% or lower, it takes a save/frame snapshot, stops the timer and recording, and waits. It resumes the retained process after AC is connected or the battery rises above 3%; after an actual power loss, boot recovery uses the durable save. Plugging in power cannot itself wake hardware that the firmware leaves suspended, but the first subsequent wake resumes automatically.

For boot-time startup, verify `loginctl show-user "$USER" -p Linger` reports `yes` (enable linger once if needed). The game and recorder use private virtual displays and never require a physical desktop session.

Defaults:

- model: `gpt-6-astra`
- launcher: `codex-proxy` (local port 7890 proxy and official auth profile)
- game launch: Steam-managed by default; optional direct offline launch starts no Steam process
- reasoning effort: `high`
- completion: agent-declared success for the configured goal (Parabox referee reports `364/364`)
- prompt: generated from the configured natural-language goal and isolated computer-use tools
- recording: 1920×1080, 30 FPS Matroska parts from private displays
- virtual camera: optional 1920×1080, 30 FPS V4L2 output with the same game/session layout
- UI: native game at 1920×1080; the final 1280×1080 game pane preserves its aspect ratio, beside a 640×1080 director dashboard
- physical desktop windows: none by default; `--browser` opens only the monitoring dashboard
- native web search and network browsers: disabled
- Shell: enabled in an empty writable workspace, with outbound network disabled
- skills, plugins, apps, memory, and sub-agents: retained from the selected Codex home
- quota retry: reported reset time + 1 minute; 5-hour fallback
- multi-account reserve: configurable per account in the control page; newly reset account first
- low-battery pause: 3% while discharging; resume on safe battery or external power
- crash checkpoint: cumulative time/tokens, provider token cursor, thread ID, progress, and game save every 5 seconds

Useful variants:

```bash
node dist/src/cli.js run --reasoning xhigh
node dist/src/cli.js run --quota-wait-hours 5
node dist/src/cli.js run --codex-home ~/.codex-official
node dist/src/cli.js run --offline
node dist/src/cli.js run --no-record
node dist/src/cli.js run --virtual-camera /dev/video10
node dist/src/cli.js run --browser
node dist/src/cli.js run --foreground
node dist/src/cli.js status
node dist/src/cli.js assemble
node dist/src/cli.js resume runs/<run-id>
node dist/src/cli.js cancel runs/<run-id>
node dist/src/cli.js restore runs/<run-id>/save-recovery.json
```

The default background `run` is independent of its launching terminal. The
diagnostic `run --foreground` variant remains attached, and `Ctrl+C` pauses that
variant for manual inspection. `SIGTERM`, an unexpected runner death, or a
reboot leaves the challenge eligible for automatic restart. Every recording
part uses regenerated frame-count timestamps, so suspend gaps do not inflate its
duration and ordered parts are directly concatenable. The active challenge
timer excludes quota, power, suspend, and reboot downtime and resumes from its checkpoint;
the final summary also reports total wall time, inactive time, attempt count,
and whether the run was `continuous` or `resumed`.

`--offline` is a true direct-launch mode: Windows executables run through
Proton and native Linux executables run directly, without starting or logging
in to Steam. It is suitable only for games that do not require Steamworks or
Steam DRM; launch failures remain visible in the director transcript and run
logs. The same option is available as **直接离线启动** in the control page.

Run artifacts are written under `runs/` and ignored by Git. Interrupted recording parts remain independently playable. At every sealed snapshot boundary, the runner atomically refreshes `production/challenge-production-so-far.mkv`; an independent assembler service applies the same operation to a runner that was already active during an upgrade. It cuts each resumed part at the recorded active-time boundary, normalizes that part once, then stream-copies the normalized parts into the cumulative video. `assemble` performs the operation on demand without touching an open part. On completion the output is `production/challenge-complete.mkv`. Non-destructive repaired release copies take precedence over damaged originals. Each completed run ends with a SHA-256 manifest. Keep the raw artifacts next to the published video or release them separately; do not commit game frames or save files to this repository.

## Public interfaces

The loopback director server exposes:

- `GET /api/challenge/time` — official monotonic elapsed time
- `GET /api/challenge/tokens` — cumulative input, cached input, output, reasoning output, and total tokens
- `GET /api/challenge` — dashboard snapshot, including referee-only visible progress
- `GET /api/status` — complete active configuration, current account five-hour/weekly used and remaining percentages, every account's sanitized telemetry, the earliest pool reset, recording state, and virtual-camera state
- `GET /api/events` — Server-Sent Events for state and transcript updates

## Optional virtual camera

The control page lists only writable V4L2 loopback outputs, never physical webcams. On Arch Linux, create one before starting the arena:

```bash
sudo pacman -S v4l2loopback-dkms
sudo modprobe v4l2loopback video_nr=10 card_label="Astra Game Arena" exclusive_caps=1
```

Then enable **输出虚拟摄像头** in the challenge settings (or pass `--virtual-camera /dev/video10`). OBS, Tencent Meeting, and other V4L2 clients can select **Astra Game Arena**. The output is live-only and independent of the on-disk recording toggle. `npm run doctor` reports whether a writable loopback device is ready.

Codex receives matching MCP tools named `challenge_time` and `challenge_tokens`, plus `observe_screen`, `press_keys`, `type_text`, `mouse`, and `complete_challenge`. Referee progress is viewer-only and is not returned to the model.

The runner follows the documented `codex exec --json` stream and the local rollout's incremental token events. See the [Codex non-interactive mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode) and [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

The selected Codex home (or each explicitly configured account home) and its normal configuration stay active. The runner adds the Parabox MCP server, forces the official `gpt-6-astra` model, disables native web search and browser features, and uses a `workspace-write` sandbox with command network access off. Because app, plugin, and MCP traffic is outside the command sandbox, using any of them to retrieve external puzzle information invalidates the run; the complete Codex event stream is retained for audit.

## Reproducibility

The exact rules, timing boundary, accounting semantics, and allowed tool surface are fixed in [docs/PROTOCOL.md](docs/PROTOCOL.md). Recording and publishing guidance is in [docs/RECORDING.md](docs/RECORDING.md).

Patrick's Parabox is the property of its respective rights holders. This project is unaffiliated with Patrick Traynor or OpenAI.
