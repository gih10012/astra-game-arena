# Astra Game Arena

A reproducible, screen-only arena for testing whether a Codex model can complete a natural-language goal in a locally installed Steam game. Patrick's Parabox (364 official levels) is the first fully verified adapter; other installed games use the same best-effort private desktop and input boundary.

The model receives a natural-language goal, rendered game frames, keyboard/mouse actions, and two self-inspection tools for elapsed time and token usage. It receives no walkthrough, level data, or save contents. Native web search and network browsers default to disabled; normal Codex capabilities such as Shell, skills, plugins, memory, and sub-agents remain available.

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

The browser is a read-only control/monitoring plane, never a game reimplementation. It lets the operator configure a run and view the unmodified native game beside an exact Codex transcript. It is always served on loopback by the watchdog; no physical browser is opened by default. Use `http://127.0.0.1:4317/control` for configuration and `http://127.0.0.1:4317/live` as the complete 1920×1080 OBS Browser Source.

## Formal layout sample

Generate a fresh six-second 1920×1080 sample from the installed game without using model tokens:

```bash
node dist/src/cli.js smoke-headless
```

The command writes a playable `recordings/challenge-part-0001.mkv` under `.arena/`, with the native game on the left and the compact director dashboard on the right. It also verifies 30 FPS, changing native pixels, a 48 kHz stereo Opus stream from the private game sink, and save restoration.

## Requirements

The current implementation targets Linux with:

- Node.js 22+
- Codex CLI with `gpt-6-astra`
- Patrick's Parabox (Steam app `1260520`)
- Cage with its headless wlroots backend and Xwayland
- Xvfb, `xprop`, `wlr-randr`, `grim`, FFmpeg, Steam, Google Chrome, PipeWire/PulseAudio compatibility (`pactl`), a C compiler, and X11/XTest headers
- optional: `v4l2loopback` for presenting the live production layout as a virtual camera; its switch also creates a PipeWire virtual microphone carrying only the private game audio

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

If two or more separately authenticated homes exist under `~/.codex-game-arena-accounts/<label>/auth.json`, the runner enables its resumable account pool. The legacy `~/.codex-parabox-accounts` location is still discovered automatically so existing credentials are not lost. The same Codex thread is synchronized through `codex-proxy` when accounts rotate. The control page lets you enable accounts and set independent five-hour and weekly reserve percentages. The scheduler prefers a recently reset account, durably checkpoints the thread/accounting state before switching, and waits when every enabled account is below its configured reserve. The marked game process tree remains alive and frozen throughout each wait. `runs/<run-id>/account-pool.json` records only scheduling telemetry; authentication files remain outside the repository. Multi-account use is disclosed in the audit trail.

If ChatGPT reports that the selected model is unsupported, `codex-proxy` continues the existing thread with the custom-provider API-key credential already configured in `~/.codex`. The fallback uses a private 0700 runtime home outside the repository. Checkpoints and status surfaces retain only its sanitized mode, provider, and label. OAuth accounts and reserve settings stay saved but are not scheduled until a model change clears the fallback and retries the ChatGPT pool.

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
starts the challenge worker in its own transient user-systemd service and
cgroup; the worker, private compositor, game, controller, and media processes
are not children of the watchdog. The dashboard is available continuously at
`http://127.0.0.1:4317` as soon as the watchdog is installed;
follow startup and resume logs with:

```bash
journalctl --user -u astra-game-arena-watchdog.service -f
```

The service starts with the user systemd manager and watches the single active run. Restarting the watchdog or Web server does not stop or relaunch an existing worker: the same game PID tree and in-memory state remain in the independent worker cgroup. During a quota, low-power, or operator pause, the runner stops Codex and active timing immediately, sends `SIGSTOP` to every process carrying that run's private game marker, then seals the recording and live outputs on that frozen frame. Resume starts the next outputs on the frozen live frame, sends `SIGCONT` to that exact PID set, and only then restarts active timing. If a deadline passes during normal OS suspend, the first wake poll continues immediately. The watchdog does not wait for niri or another physical compositor.

The durable checkpoint is accounting and audit state, not a process snapshot. If the worker/game process dies, the machine reboots, or power is lost, native Wine/Vulkan/driver memory is gone. The arena then leaves the challenge paused and explicitly refuses a cold relaunch; it never starts the title screen behind a held JPEG and calls that a resume. Exact continuity through power-off is possible only when the host's own hibernation path has been correctly configured and validated, because hibernation preserves the entire machine image rather than reconstructing an individual game. See [Continuity and recovery guarantees](docs/CONTINUITY.md).

If Codex reports a quota/rate-limit error, the runner uses the exhausted window's reported reset time plus a one-minute safety margin. Five hours is only the fallback when Codex provides no usable reset timestamp; customize that fallback with `--quota-wait-hours`. While discharging at 3% or lower, it writes the durable accounting state, an optional adapter save, and an auditable compositor frame, then stops the timer and recording while retaining the live game process. It continues from that process after AC is connected or the battery rises above 3%. The frame and save are evidence/fallback artifacts, not substitutes for RAM; an actual power loss cannot be resumed unless the whole host successfully hibernated. Plugging in power cannot itself wake hardware that the firmware leaves suspended, but the first subsequent wake poll resumes automatically.

For boot-time startup, verify `loginctl show-user "$USER" -p Linger` reports `yes` (enable linger once if needed). The game and recorder use private virtual displays and never require a physical desktop session.

Defaults:

- model: `gpt-6-astra`
- launcher: `codex-proxy` (local port 7890 proxy and official auth profile)
- game launch: Steam online by default; choose cached Steam offline login or a direct no-Steam launch per challenge
- reasoning effort: `high`
- completion: agent-declared success for the configured goal (Parabox referee reports `364/364`)
- prompt: generated from the configured natural-language goal and isolated computer-use tools
- optional prompt guidance: explicitly encourages creating and using local scripts, skills, and sub-agents when that saves time or tokens
- recording: 1920×1080, 30 FPS Matroska parts from private displays, with 48 kHz stereo Opus captured only from the private game sink
- virtual outputs: optional 1920×1080, 30 FPS V4L2 camera with the same game/session layout, plus an `Astra Game Microphone` PipeWire source containing only audio routed by the private game runtime
- UI: native game at 1920×1080; the final 1280×1080 game pane preserves its aspect ratio, beside a 640×1080 director dashboard
- physical desktop windows: none by default; `--browser` opens only the monitoring dashboard
- native web search and network browsers: disabled by default, independently configurable
- Shell: enabled in an empty writable workspace with standard network behavior
- skills, plugins, apps, memory, and sub-agents: retained from the selected Codex home
- quota retry: reported reset time + 1 minute; 5-hour fallback
- multi-account reserve: configurable per account in the control page; newly reset account first
- low-battery pause: 3% while discharging; resume on safe battery or external power
- durable checkpoint: cumulative time/tokens, provider token cursor, thread ID, progress, optional adapter save, and an audit frame every 5 seconds; it is not an in-memory process snapshot

Useful variants:

```bash
node dist/src/cli.js run --reasoning xhigh
node dist/src/cli.js run --quota-wait-hours 5
node dist/src/cli.js run --codex-home ~/.codex-official
node dist/src/cli.js run --launch-mode steam-offline
node dist/src/cli.js run --launch-mode direct
node dist/src/cli.js run --no-record
node dist/src/cli.js run --virtual-camera /dev/video10
node dist/src/cli.js run --browser
node dist/src/cli.js run --foreground
node dist/src/cli.js status
node dist/src/cli.js assemble
node dist/src/cli.js cancel runs/<run-id>
node dist/src/cli.js restore runs/<run-id>/save-recovery.json
```

The default background `run` is independent of its launching terminal and of
the watchdog/Web service cgroup. The diagnostic `run --foreground` variant
remains attached. The control-plane pause keeps that same worker and game
process alive; resuming signals the retained worker instead of launching a new
one. An unexpected worker death, ordinary reboot, or hard power loss makes exact
resume unavailable, so the watchdog marks the challenge paused and refuses to
cold-launch it. Every recording part uses regenerated frame-count timestamps,
so suspend gaps do not inflate its duration and ordered parts are directly
concatenable. The active challenge timer excludes quota, power, and suspend
downtime and resumes from its checkpoint only while the same process survives;
the final summary also reports total wall time, inactive time, attempt count,
and whether the run was `continuous` or `resumed`.

`--launch-mode steam-offline` starts Steam with the locally cached license and
offline login state, then launches the selected title through Steam. The
temporary `loginusers.vdf` change is restored byte-for-byte on teardown. This
is the verified path for Civilization VI. `--launch-mode direct` is a true
no-Steam launch: Windows executables run through Proton and native Linux
executables run directly. It is suitable only for games that do not require
Steamworks or Steam DRM; launch failures remain visible in the director
transcript and run logs. The control page exposes all three modes in its
“游戏启动方式” selector; legacy `--offline` remains an alias for `direct`.

While a challenge is active, the control page can change the goal, model,
reasoning effort, Web Search, Browser Use, helper-tool guidance, recording,
virtual camera, account pool, and quota policy. Goal and agent-setting changes
restart only `codex exec` and resume the same Codex thread; the game, official
timer, recording process, virtual camera, and current recording part remain
live. Game, GPU, and launch-mode selection stay locked for the lifetime of that
game process; changing them requires ending the challenge and starting a new
one.

Run artifacts are written under `runs/` and ignored by Git. Interrupted recording parts remain independently playable. At every sealed recording boundary, the runner atomically refreshes `production/challenge-production-so-far.mkv`; an independent assembler service applies the same operation to a runner that was already active during an upgrade. It normalizes every sealed part from its first frame and stream-copies the normalized parts into the cumulative video without trimming. It never discards opening seconds to conceal a relaunch: a relaunch is forbidden. `assemble` performs the operation on demand without touching an open part. On completion the output is `production/challenge-complete.mkv`. Non-destructive repaired release copies take precedence over damaged originals. Each completed run ends with a SHA-256 manifest. Keep the raw artifacts next to the published video or release them separately; do not commit game frames or save files to this repository.

## Public interfaces

The loopback director server exposes:

- `GET /api/challenge/time` — official monotonic elapsed time
- `GET /api/challenge/tokens` — cumulative input, cached input, output, reasoning output, and total tokens
- `GET /api/challenge` — dashboard snapshot, including referee-only visible progress
- `GET /api/status` — complete active and broadcast configuration, current account five-hour/weekly used and remaining percentages, every account's sanitized telemetry, the earliest pool reset, recording state, virtual-camera/microphone state, and explicit retained/frozen/cold-relaunch continuity state
- `PATCH /api/configuration` — hot-update the active goal and agent/media/account settings; Web Search and Browser Use are separate booleans
- `GET /api/events` — Server-Sent Events for state and transcript updates
- `GET /api/broadcast` — persisted OBS mode, replay rules, media library, playlist, audio setting, and the current live/replay decision
- `PATCH /api/broadcast` — atomically save broadcast mode, rules, playlist order, badge, and volume without pausing a challenge
- `POST /api/broadcast/media` — add an existing local video path to the replay library without copying or deleting it
- `DELETE /api/broadcast/media?id=…` — forget a manually added path without deleting the underlying video
- `GET /api/broadcast/replay.mjpeg?id=…` — server-decoded replay picture for a selected playlist item, avoiding browser GPU-video overlays
- `GET /api/broadcast/replay-audio.ogg?id=…` — matching Opus audio when the selected item contains audio
- `GET /api/music` / `PATCH /api/music` — sanitized runtime state and durable point-song/source/overlay settings
- `POST /api/music/request`, `/api/music/skip`, `/api/music/vip` — manual queue, skip, and three-hour VIP check-in controls
- `GET /api/music/audio.ogg` — the server-side broadcast music sink as a reconnectable Opus stream used by `/live`

## One-source OBS live page

Add one OBS **Browser Source** with URL `http://127.0.0.1:4317/live`, width
`1920`, height `1080`, and enable **Control audio via OBS**. Do not add the
MJPEG, game microphone, virtual camera, or replay endpoints separately. The
page itself is the program output and contains all of these transitions:

- while a challenge is running, the exact no-controls director layout and the
  private game's PipeWire audio are live;
- while idle or waiting for quota, the configured local playlist is streamed
  in real time with an unambiguous replay badge;
- quota replay additionally shows the checkpoint's exact expected reset time
  and a live countdown; and
- when no selected replay is available, the director remains in a truthful
  standby state instead of inventing footage.

The same page can run the optional Bilibili jukebox in every mode. A viewer
sends `点歌 歌名` (the command is configurable); the server receives native
Bilibili WebSocket events, deduplicates the queue, and plays a random daily
recommendation whenever the queue is empty. Song/artist cards, queue changes,
the interaction hint, and the current vertically rendered synchronized lyric
are composited by `/live` itself. Their visibility, timings, and lyric X/Y
position are live settings, so OBS needs no additional browser, audio, or text
source.

Open `http://127.0.0.1:4317/control`, then choose **直播控制** to set automatic,
forced-live, or forced-replay mode; choose replay triggers; order files; change
the badge and volume; or preview the exact output with monitoring muted. The
server persists these settings to ignored local state at
`.arena/broadcast-config.json`. Challenge form edits are also kept as a browser
`localStorage` draft until successfully submitted. Dropped browser tabs,
watchdog restarts, and machine restarts do not lose the saved broadcast
configuration. See [`docs/BROADCAST.md`](docs/BROADCAST.md) for details.

Music settings are independently saved to ignored local state at
`.arena/music-config.json`. The default adapter uses the already logged-in
MoeKoeMusic profile and its Kugou catalog; credentials are read only for each
local provider request and never appear in the saved configuration or status
API. A MoeKoe-compatible HTTP source can be selected instead, while the
danmaku, queue, daily fallback, lyrics, and overlays remain provider-neutral.
Restricted-track failures can automatically perform the configured legacy
three-hour VIP check-in, and the control page also exposes a manual check-in.

## Optional virtual camera and game microphone

The control page lists only writable V4L2 loopback outputs, never physical webcams. On Arch Linux, create one before starting the arena:

```bash
sudo pacman -S v4l2loopback-dkms
sudo modprobe v4l2loopback video_nr=10 card_label="Astra Game Arena" exclusive_caps=1
```

Then enable **输出虚拟摄像头 + 游戏麦克风** in the challenge settings (or pass `--virtual-camera /dev/video10`). OBS, Tencent Meeting, and other V4L2 clients can select **Astra Game Arena** as the camera and **Astra Game Microphone** as the microphone. The microphone is a PipeWire/PulseAudio-compatible source fed only by the sink assigned to the private game process; it does not mix the physical microphone or ordinary desktop audio. Both outputs are live-only and independent of the on-disk recording toggle. `npm run doctor` reports whether the audio compatibility layer and a writable loopback device are ready.

While a challenge process is active, the monitor's game pane receives the private compositor stream through the same-origin `/api/live.mjpeg` endpoint at 1280×720 / 30 FPS. This does not depend on the virtual-output toggle. While the retained game is paused it remains a live view of that process; after process loss, the last auditable JPEG is explicitly only a diagnostic frame and cannot authorize resume. The browser never receives direct device access or a camera-permission prompt. The hidden director renderer reads the same live checkpoint, account, recording, virtual-camera, and virtual-microphone status as the public monitor without contacting the public control plane.

Codex receives matching MCP tools named `challenge_time` and `challenge_tokens`, plus `observe_screen`, `press_keys`, `type_text`, `mouse`, and `complete_challenge`. Referee progress is viewer-only and is not returned to the model.

For example, this minimal script clicks the private game coordinate `(10,10)`
ten times, then types `halloworld` one character at a time. It calls only the
run-local controller and cannot operate the physical desktop. The runner passes
both values as environment variables; never embed the control token in a script
or log. A single `mouse` call is limited to three clicks, so the loop uses
`3 + 3 + 3 + 1`.

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${ARENA_URL:?provided by the arena runner}"
: "${ARENA_CONTROL_TOKEN:?provided by the arena runner}"

arena_post() {
  curl --noproxy '*' -fsS \
    -H "Authorization: Bearer ${ARENA_CONTROL_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data "$2" "${ARENA_URL}$1" >/dev/null
}

for count in 3 3 3 1; do
  arena_post /internal/pointer \
    "{\"action\":\"click\",\"x\":10,\"y\":10,\"button\":\"left\",\"count\":${count},\"settleMs\":0}"
done
arena_post /internal/type \
  '{"text":"halloworld","intervalMs":50,"settleMs":100}'
```

The runner follows the documented `codex exec --json` stream and the local rollout's incremental token events. See the [Codex non-interactive mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode) and [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

The selected Codex home (or each explicitly configured account home) and its normal configuration stay active. The runner adds the arena MCP server, forces the selected model, applies the separately configured Web Search and Browser Use policy, and otherwise retains standard Shell, skill, plugin, app, memory, and sub-agent capabilities in a `workspace-write` sandbox. For a no-network benchmark, leave both network switches off; using another capability to retrieve external puzzle information still invalidates that run. The complete Codex event stream and each configuration change are retained for audit.

## Reproducibility

The exact rules, timing boundary, accounting semantics, and allowed tool surface are fixed in [docs/PROTOCOL.md](docs/PROTOCOL.md). The process-retention and host-sleep boundary is documented in [docs/CONTINUITY.md](docs/CONTINUITY.md). Recording and publishing guidance is in [docs/RECORDING.md](docs/RECORDING.md).

Patrick's Parabox is the property of its respective rights holders. This project is unaffiliated with Patrick Traynor or OpenAI.
