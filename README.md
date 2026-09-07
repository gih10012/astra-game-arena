# Astra × Parabox Benchmark

A reproducible, screen-only benchmark harness for testing whether GPT-6-Astra can complete all **364 official levels** of Patrick's Parabox from a clean save.

The model receives one neutral task sentence, rendered game frames, keyboard actions, and two self-inspection tools for elapsed time and token usage. It receives no walkthrough, level data, or save contents. Native web search and network browsers are disabled; normal Codex capabilities such as Shell, skills, plugins, memory, and sub-agents remain available.

> This repository contains no game binary, game assets, save data, or recorded footage. A legitimately purchased Steam copy of Patrick's Parabox is required.

## Why this architecture

The native game window remains the sole source of truth. It runs on an isolated Gamescope headless display, where a local MCP bridge requests compositor screenshots and sends keyboard events. The latest lossless compositor view is mirrored into one private Xvfb display, while a separate Chrome instance renders the director dashboard in another. Neither window is mapped to the operator's physical desktop. The mirror avoids undefined X11 backing-buffer contents from Vulkan/Unity windows.

```text
                    ┌─ observe_game / press_keys ─┐
GPT-6-Astra (Codex) ┤                              ├─ Native game in Gamescope headless
                    └─ challenge_time / tokens ───┤
                                                  │
Codex JSONL + rollout usage ── Arena controller ──┼─ Director dashboard
Game save (referee only) ─────────────────────────┘
                                                  │
Gamescope compositor → private game mirror + dashboard Xvfb ── FFmpeg → parts
```

The browser is deliberately not the control plane. This avoids a lossy browser reimplementation of the game, cuts latency, and lets viewers see the unmodified native game beside an exact, read-only Codex transcript. The loopback dashboard URL remains available for an operator to open manually, but no physical browser is opened by default.

## Formal layout sample

[Download the 6-second 1920×1080 sample](https://github.com/gih10012/astra-parabox-benchmark/releases/download/headless-sample-v0.2.0/astra-parabox-formal-sample.mp4). Both panes were rendered and captured on private virtual displays. The left pane is the real Steam game; the right pane is a director-dashboard rehearsal. This is a production/layout sample, not a claimed benchmark result, and it uses no model tokens.

## Requirements

The current implementation targets Linux with:

- Node.js 22+
- Codex CLI with `gpt-6-astra`
- Patrick's Parabox (Steam app `1260520`)
- Gamescope with its headless backend and Xwayland
- Xvfb, `xprop`, FFmpeg, Steam, Google Chrome, a C compiler, and X11/XTest headers

On Arch Linux the additional runtime packages are:

```bash
sudo pacman -S gamescope xorg-server-xvfb xorg-xprop libxtst
```

Install and verify:

```bash
npm install
npm run build
npm run doctor
```

By default, the harness uses `~/.codex-official` when that directory contains `auth.json`, then falls back to the normal Codex home. Override it with `--codex-home PATH` or `ASTRA_CODEX_HOME`. Credentials are never copied into run artifacts.

If two or more separately authenticated homes exist under `~/.codex-parabox-accounts/<label>/auth.json`, the runner enables its resumable account pool. The same Codex thread is synchronized through `codex-proxy` when accounts rotate. It prefers an account whose five-hour window most recently reset, immediately rotates away from an exhausted account, and stops at the next snapshot boundary whenever continuing would leave every account with less than 50% of its five-hour allowance. `runs/<run-id>/account-pool.json` records only scheduling telemetry; authentication files remain outside the repository. Multi-account use is disclosed in the audit trail.

Validate authentication and the four benchmark-specific MCP tools with a small, non-challenge GPT-6-Astra turn before touching saves:

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
becomes available at `http://127.0.0.1:4317` after the hidden game starts;
follow startup and resume logs with:

```bash
journalctl --user -u astra-parabox-watchdog.service -f
```

The service starts with the user systemd manager and watches the single active run. During a quota wait the recorder and active timer stop, while the hidden game/controller process remains alive; the same in-memory game state and Codex thread resume when the reset deadline passes. A normal OS suspend freezes that process and continues from the same state on wake. A reboot cannot preserve Wine/GPU RAM, so the watchdog relaunches from the durable game save and resumes the persisted Codex `thread_id`. The next recording part first holds the last compositor snapshot while the title screen is handled behind it, then switches to the restored live frame; the title page therefore appears only in the initial part. If the deadline passed while asleep or powered off, the first wake/boot poll resumes immediately. The watchdog does not wait for niri or another physical compositor.

If Codex reports a quota/rate-limit error, the runner uses the exhausted window's reported reset time plus a one-minute safety margin. Five hours is only the fallback when Codex provides no usable reset timestamp; customize that fallback with `--quota-wait-hours`. While discharging at 3% or lower, it takes a save/frame snapshot, stops the timer and recording, and waits. It resumes the retained process after AC is connected or the battery rises above 3%; after an actual power loss, boot recovery uses the durable save. Plugging in power cannot itself wake hardware that the firmware leaves suspended, but the first subsequent wake resumes automatically.

For boot-time startup, verify `loginctl show-user "$USER" -p Linger` reports `yes` (enable linger once if needed). The game and recorder use private virtual displays and never require a physical desktop session.

Defaults:

- model: `gpt-6-astra`
- launcher: `codex-proxy` (local port 7890 proxy and official auth profile)
- reasoning effort: `high`
- completion: exactly `364/364`
- prompt: `Complete all 364 official levels in Patrick's Parabox. Use the Parabox tools for game observation and control. Do not search or browse the internet.`
- recording: 1920×1080, 30 FPS Matroska parts from private displays
- UI: native game at 1280×1080, director dashboard at 640×1080
- physical desktop windows: none by default; `--browser` opens only the monitoring dashboard
- native web search and network browsers: disabled
- Shell: enabled in an empty writable workspace, with outbound network disabled
- skills, plugins, apps, memory, and sub-agents: retained from the selected Codex home
- quota retry: reported reset time + 1 minute; 5-hour fallback
- multi-account reserve: keep at least one five-hour allowance 50% available; newly reset account first
- low-battery pause: 3% while discharging; resume on safe battery or external power
- crash checkpoint: cumulative time/tokens, provider token cursor, thread ID, progress, and game save every 5 seconds

Useful variants:

```bash
node dist/src/cli.js run --reasoning xhigh
node dist/src/cli.js run --quota-wait-hours 5
node dist/src/cli.js run --codex-home ~/.codex-official
node dist/src/cli.js run --no-record
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

Run artifacts are written under `runs/` and ignored by Git. Interrupted recording parts remain independently playable. At every sealed snapshot boundary, the runner atomically refreshes `production/challenge-production-so-far.mkv`; an independent assembler service applies the same operation to a runner that was already active during an upgrade. It cuts each resumed part at the recorded active-time boundary, normalizes that part once, then stream-copies the normalized parts into the cumulative video. `assemble` performs the operation on demand without touching an open part. On completion the output is `production/challenge-complete.mkv`. Non-destructive repaired release copies take precedence over damaged originals. Each completed run ends with a SHA-256 manifest. Keep the raw artifacts next to the published video or release them separately; do not commit game frames or save files to this repository.

## Public interfaces

The loopback director server exposes:

- `GET /api/challenge/time` — official monotonic elapsed time
- `GET /api/challenge/tokens` — cumulative input, cached input, output, reasoning output, and total tokens
- `GET /api/challenge` — dashboard snapshot, including referee-only visible progress
- `GET /api/events` — Server-Sent Events for state and transcript updates

Codex receives matching MCP tools named `challenge_time` and `challenge_tokens`, plus `observe_game` and `press_keys`. The progress counter is intentionally not returned to Codex because it is derived from the save file rather than pixels.

The runner follows the documented `codex exec --json` stream and the local rollout's incremental token events. See the [Codex non-interactive mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode) and [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

The selected Codex home (or each explicitly configured account home) and its normal configuration stay active. The runner adds the Parabox MCP server, forces the official `gpt-6-astra` model, disables native web search and browser features, and uses a `workspace-write` sandbox with command network access off. Because app, plugin, and MCP traffic is outside the command sandbox, using any of them to retrieve external puzzle information invalidates the run; the complete Codex event stream is retained for audit.

## Reproducibility

The exact rules, timing boundary, accounting semantics, and allowed tool surface are fixed in [docs/PROTOCOL.md](docs/PROTOCOL.md). Recording and publishing guidance is in [docs/RECORDING.md](docs/RECORDING.md).

Patrick's Parabox is the property of its respective rights holders. This project is unaffiliated with Patrick Traynor or OpenAI.
