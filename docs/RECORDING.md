# Recording and release checklist

## Before the take

1. Close Steam completely and disable Steam Cloud for app 1260520. The runner refuses to start if Steam is already running, because its single-instance forwarding could target the physical desktop.
2. Verify no separate screen recorder is capturing the physical desktop; the arena itself uses only private virtual displays.
3. Run `npm run doctor` and require every required check to pass.
4. Run `node dist/src/cli.js smoke-model`; do not start a formal run unless it succeeds.
5. Run `node dist/src/cli.js smoke-headless` once to verify the hidden game, keyboard, dashboard, and 1920×1080 recorder path. This does not use model tokens or alter save progress.
6. Run `node dist/src/cli.js service install` and confirm the watchdog is active.
7. Ensure enough free space for long 30 FPS Matroska recording parts and connect stable power/network. The model API needs network. Native search/browser surfaces default to disabled; Shell and other normal Codex capabilities remain enabled, but using any alternate route to retrieve external puzzle information invalidates a declared no-network run.
8. If live outputs are needed in OBS or a meeting client, load a dedicated `v4l2loopback` device and enable it in the web settings. This exposes both the V4L2 camera and an `Astra Game Microphone` PipeWire source carrying only the private game's audio. It does not require on-disk recording to be enabled.

For OBS specifically, the preferred setup is a single 1920×1080 Browser Source
pointing to `http://127.0.0.1:4317/live` with **Control audio via OBS** enabled.
That one page carries the complete director picture, game sound, and optional
Bilibili point-song music/overlays, and can
visibly switch to the locally configured replay playlist while idle or waiting
for quota. The replay label and reset time make the source type explicit; see
[`BROADCAST.md`](BROADCAST.md).

## During the take

The runner opens the selected native game inside Cage's private headless Xwayland. `wf-recorder` continuously captures the native game output together with the run-specific game sink monitor as 48 kHz stereo Opus, and FFmpeg combines it with the compact director dashboard from a second private Xvfb display while retaining that audio. It opens nothing on niri or any other physical compositor by default. The controller logs a loopback dashboard URL; `--browser` is the explicit opt-in to open it automatically. Do not interact after the timer starts. Infrastructure recovery is allowed only through the recorded watchdog path; human gameplay makes the run invalid.

When enabled, a second live compositor capture is combined with that same dashboard and written to the selected V4L2 loopback output at 1920×1080/30 FPS. The private game is also assigned a dedicated PipeWire/PulseAudio-compatible sink whose monitor is published as `Astra Game Microphone`. It excludes the physical microphone and ordinary desktop audio. The outputs stop while the challenge is paused and return from the same retained game process on resume; the video path never reads from or overwrites a physical webcam.

The initial recording starts on the real title page before any Enter key is sent. At a quota, power, or operator boundary the marked game process tree is frozen before the current recorders are sealed. The next part begins on that frozen live frame and only then thaws the same PIDs, so no captured frame is removed and no title sequence is introduced. Restarting the watchdog or Web server does not restart the independent challenge worker or game cgroup. If the worker/game dies, if the machine performs an ordinary reboot, or if power is lost without successful whole-host hibernation, the challenge remains paused and no later part is fabricated: cold relaunch, held-frame masking, and trimming seconds to conceal startup are forbidden.

Changing the goal or an agent setting (including search, browser, and helper-tool guidance) hot-reloads only the Codex client on the same thread. The game, timer, recorder, virtual camera, virtual game microphone, and current video part stay continuous. This boundary is logged but is not a recording cut. Game, GPU, and launch mode remain locked until the challenge ends.

If an assembler or dashboard service restarts, the independently supervised live runner and game continue untouched. The low-priority assembler rebuilds a sealed prior part atomically from its preserved raw game/dashboard streams and refreshes the production cut without pausing gameplay. If the challenge worker itself is gone, media repair may preserve already recorded evidence but must not launch a new game attempt.

The director dashboard shows:

- exact wall-clock elapsed time;
- Codex-reported cumulative tokens and their breakdown;
- referee progress for viewers only;
- model/status and separate live search/browser policy badges; and
- sanitized live reasoning summaries and MCP tool calls.

The dashboard does not send commands and is not visible to the model.

## After the take

1. Confirm `summary.json` says `completed`, `364/364`, and `savesRestored: true`; disclose its `continuous` or `resumed` classification.
2. Run the test suite again at the exact commit used for the challenge.
3. Verify `manifest.sha256.json` against the artifacts.
4. Verify `production/assembly.json` and use `production/challenge-complete.mkv` as the edit master, then transcode it to the platform delivery format; retain every original part. The assembler normalizes each sealed part from its first frame and atomically concatenates the complete parts without trimming. It does not remove seconds to conceal a game relaunch. If a legacy part predates frame-count timestamp regeneration, its documented non-destructive repair copy is selected automatically.
5. Put the repository commit SHA, model, effort, Codex version, timer, token breakdown, prompt, and artifact manifest hash in the video description.
6. Review raw logs, save files, browser profile, and frames before publishing. Do not upload credentials, local paths that reveal private information, or proprietary game data beyond footage permitted by the rights holder/platform.

Recommended video framing is 2560×1440 or 1920×1080, with the game using roughly two thirds of the width. Preserve legible token/time figures at the final delivery resolution.
