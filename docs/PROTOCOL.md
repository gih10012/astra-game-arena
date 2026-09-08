# Benchmark protocol

## Challenge definition

- Start from no Patrick's Parabox save slots and finish when a runtime-only referee observes exactly 364 completed entries out of 364 official entries.
- Give the selected Codex model the configured natural-language goal and generic computer-use tools. The Parabox default goal is `Complete all official levels in Patrick's Parabox.` The operator may change the goal during a run; the next continuation explicitly restates the new goal on the same thread.
- After an infrastructure or quota interruption, resume the same Codex thread from the current game state and restate the current goal and active search/browser policy. Each such continuation is recorded and makes the result a `resumed` run.
- Use `high` reasoning effort by default. A different effort makes a distinct benchmark run and must be shown in its metadata.
- Completion is the hard requirement. Wall-clock time and token use are reported as separate metrics; they are not combined into a score.

## Model-visible surface

The harness adds generic benchmark MCP tools:

1. `observe_screen()` returns a current JPEG screenshot of the native private desktop.
2. `press_keys(...)` and `type_text(...)` send bounded keyboard input; `mouse(...)` sends private pointer input.
3. `challenge_time()` returns the official elapsed time snapshot.
4. `challenge_tokens()` returns the latest cumulative token snapshot.
5. `complete_challenge(...)` records the agent's completion declaration.

The game adapter never reads process memory, game assets, level definitions, save files, OCR, accessibility trees, or symbolic state for the model. The referee reads the save only to determine progress and completion, and does not expose that value through MCP.

The selected Codex home and its normal configuration remain active. Shell, local tools, apps, plugins, skills, memories, hooks, and multi-agent tools are not disabled by the harness. The shell starts in an empty `workspace-write` directory with its standard network behavior.

Native Web Search and Codex Browser Use are independent, operator-visible switches and both default to disabled. A configuration change is audited and takes effect by resuming `codex exec` on the same thread. If a run is declared no-network, using Shell, an app, a plugin, another MCP server, memory, or a sub-agent to retrieve external puzzle information invalidates it. Such tool activity remains in the raw Codex event log for audit. The optional helper-tool prompt switch merely encourages efficient local scripts, skills, and sub-agents; it does not grant a new capability or relax the game-observation boundary. The arena MCP server exposes only the computer-use, accounting, and explicit completion tools above.

The arena tools are pre-approved so an unattended run never blocks on a confirmation dialog. Other tool approvals continue to follow the selected Codex configuration and the non-interactive approval policy.

## Checkpoints and recovery

- Exactly one active run is registered under `.arena/active-run.json`.
- `checkpoint.json` and the latest challenge save are atomically replaced and synced every five seconds while the model is active.
- The checkpoint includes the Codex thread ID, attempt number, cumulative active time, cumulative token totals, the last provider token cursor, referee progress, retry time, recording-part list, and sanitized credential mode/provider/label. It never contains the arena control token, API key, token, or credential-home path.
- Quota and rate-limit errors enter `waiting_quota`. The retry uses Codex's machine-readable `resets_at` for the exhausted 5-hour or weekly window, plus a one-minute margin. If multiple windows are exhausted, it uses the later reset. Five hours is the fallback only when no valid future timestamp is available.
- When multiple explicitly authenticated account homes are configured, the audit records each account-label selection. The scheduler prefers the account whose five-hour window most recently reset, proactively snapshots and rotates when a newer reset becomes eligible, and rotates immediately after quota exhaustion. It never intentionally consumes beyond each account's configured five-hour/weekly reserve; if necessary, it snapshots and waits for the next eligible reset. Token totals remain cumulative across the single resumed challenge thread.
- If ChatGPT rejects the selected model as unsupported, the runner resumes that same thread through the configured `~/.codex` custom-provider API key. Only the credential mode, provider, and display label enter the checkpoint or status API; the key and credential-home path never enter run artifacts. While the API key is active, OAuth scheduling is inactive but its accounts, reserve policies, and real historical allowance telemetry remain retained. Selecting a different model clears the fallback and tries the ChatGPT pool again.
- A quota retry retains the live hidden game and controller. Recording and active timing stop at the boundary; the next part resumes the same process after the absolute reset deadline. If the computer was suspended past that deadline, the next wake poll continues immediately.
- At 3% battery or lower while discharging, the runner enters `waiting_power`, checkpoints the game save and a compositor frame, and stops active timing/recording. Connecting external power or recovering above 3% resumes the retained process. Boot recovery observes the same gate before launching.
- A stale `running` checkpoint after process death or reboot becomes immediately eligible for watchdog recovery once the user's runtime directory is available. A physical compositor is not required.
- Suspend retains exact in-memory game state. Reboot/power loss cannot retain Wine/GPU memory; it relaunches from the durable game save and resumes the same persisted Codex thread. The next recording part begins on the last durable compositor frame, keeps that frame visible while the hidden title screen is dismissed, and switches to live pixels only after save restoration. Only the first recording contains the title page.
- `SIGINT` creates a manual `paused` state. `SIGTERM` creates an immediately retryable state for shutdown/service restart.
- A goal, model, reasoning, search/browser, or helper-guidance update restarts only the Codex client and resumes the same thread. It does not pause the active timer, snapshot/relaunch the game, stop the recorder or virtual camera, create a new attempt, or start a new recording part.
- The original player saves remain in `save-backup/` throughout an incomplete run. A completed challenge archives the final challenge save and restores the originals.

## Metric boundaries

- The monotonic timer starts immediately before the `codex exec` process is spawned, after the clean game window, controller, two private virtual displays, and recorder are ready.
- The timer freezes on the first referee sample showing 364/364. Setup, teardown, video finalization, and original-save restoration are excluded.
- Active elapsed time sums only intervals in which an attempt has reached the ready game/controller/recorder boundary and Codex is running. Quota, power, suspend and reboot downtime, and recovery setup are excluded.
- The final summary separately reports wall elapsed time and inactive elapsed time. Only an attempt count of one is classified as `continuous`; any recovered run is classified as `resumed`.
- Token usage is read from Codex's `token_count.info.total_token_usage` rollout events during each turn and reconciled with final `turn.completed.usage` from `codex exec --json`. Codex resets that provider counter for a new turn, so the runner persists its last provider cursor and adds only deltas to the challenge-wide total. Old rollout events replayed while attaching to an existing thread are timestamp-filtered and never counted again.
- `totalTokens` uses Codex's reported total. Cached input is reported separately and is not added a second time. Reasoning output is reported separately as the provider's breakdown.
- A mid-run token query is necessarily a slightly stale sample and cannot include the tokens used to emit that same query. The final summary is authoritative.

## Audit artifacts

Every run records:

- initial run metadata, every runtime configuration change, and the exact initial/continuation prompts;
- redacted Codex command/configuration;
- raw `codex exec --json` events and incremental usage events;
- dashboard/referee events and final summary;
- recoverable original-save backup and completed challenge save;
- one 1920×1080 Matroska recording part per active attempt, with input timestamps regenerated from frame counts so suspend gaps cannot inflate duration; and
- a SHA-256 manifest over all run artifacts.

Run artifacts can contain copyrighted screenshots and private local state. Review them before public release. Publish hashes even when large or sensitive raw artifacts are withheld.
