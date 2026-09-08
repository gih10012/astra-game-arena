# Recording and release checklist

## Before the take

1. Close Steam completely and disable Steam Cloud for app 1260520. The runner refuses to start if Steam is already running, because its single-instance forwarding could target the physical desktop.
2. Verify no separate screen recorder is capturing the physical desktop; the arena itself uses only private virtual displays.
3. Run `npm run doctor` and require every required check to pass.
4. Run `node dist/src/cli.js smoke-model`; do not start a formal run unless it succeeds.
5. Run `node dist/src/cli.js smoke-headless` once to verify the hidden game, keyboard, dashboard, and 1920×1080 recorder path. This does not use model tokens or alter save progress.
6. Run `node dist/src/cli.js service install` and confirm the watchdog is active.
7. Ensure enough free space for long 30 FPS Matroska recording parts and connect stable power/network. The model API needs network. Native search/browser surfaces default to disabled; Shell and other normal Codex capabilities remain enabled, but using any alternate route to retrieve external puzzle information invalidates a declared no-network run.
8. If a live feed is needed in OBS or a meeting client, load a dedicated `v4l2loopback` device and enable it in the web settings. This does not require on-disk recording to be enabled.

## During the take

The runner opens the selected native game inside Cage's private headless Xwayland. `wf-recorder` continuously captures the native game output, and FFmpeg combines it with the compact director dashboard from a second private Xvfb display. It opens nothing on niri or any other physical compositor by default. The controller logs a loopback dashboard URL; `--browser` is the explicit opt-in to open it automatically. Do not interact after the timer starts. Infrastructure recovery is allowed only through the recorded watchdog path; human gameplay makes the run invalid.

When enabled, a second live compositor capture is combined with that same dashboard and written to the selected V4L2 loopback output at 1920×1080/30 FPS. The loopback stream stops at snapshot boundaries and returns with the restored view on resume; it never reads from or overwrites a physical webcam.

The initial recording starts on the real title page before any Enter key is sent. Later quota/power parts resume the retained process directly. After a cold reboot, a holding copy of the last compositor snapshot is recorded while the relaunched game restores its save behind the mirror; the mirror switches to live pixels only after the hidden title page has been dismissed. The persisted Codex `thread_id`, cumulative timer, and token counters resume with that same boundary, so a title page is never introduced into a later part.

Changing the goal or an agent setting (including search, browser, and helper-tool guidance) hot-reloads only the Codex client on the same thread. The game, timer, recorder, virtual camera, and current video part stay continuous. This boundary is logged but is not a snapshot or recording cut.

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
4. Verify `production/assembly.json` and use `production/challenge-complete.mkv` as the edit master, then transcode it to the platform delivery format; retain every original part. The assembler cuts resumed parts at their recorded active-time/snapshot boundary, normalizes each sealed part once, and atomically concatenates them. If a legacy part predates frame-count timestamp regeneration, its documented non-destructive repair copy is selected automatically.
5. Put the repository commit SHA, model, effort, Codex version, timer, token breakdown, prompt, and artifact manifest hash in the video description.
6. Review raw logs, save files, browser profile, and frames before publishing. Do not upload credentials, local paths that reveal private information, or proprietary game data beyond footage permitted by the rights holder/platform.

Recommended video framing is 2560×1440 or 1920×1080, with the game using roughly two thirds of the width. Preserve legible token/time figures at the final delivery resolution.
