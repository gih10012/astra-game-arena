import assert from "node:assert/strict";
import test from "node:test";
import { extractQuotaResetAt } from "../src/codex-events.js";
import { codexEnvironment } from "../src/codex-home.js";
import {
  codexArguments,
  isQuotaError,
  extractQuotaResetAtFromText,
  NEUTRAL_PROMPT,
  quotaRetryAt,
  RESUME_PROMPT,
} from "../src/runner.js";

test("disables search and browsers while retaining normal Codex capabilities", () => {
  const args = codexArguments({
    mcpEntry: "/arena/mcp.js",
    arenaUrl: "http://127.0.0.1:4317",
    controlToken: "secret",
    reasoningEffort: "high",
  });
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes("tools.web_search=false"));
  assert.ok(args.includes("features.browser_use=false"));
  assert.ok(args.includes("features.browser_use_external=false"));
  assert.ok(args.includes("features.in_app_browser=false"));
  assert.ok(args.includes("sandbox_workspace_write.network_access=false"));
  assert.equal(args.includes("--ignore-user-config"), false);
  assert.equal(args.includes("features.shell_tool=false"), false);
  assert.equal(args.includes("features.multi_agent=false"), false);
  assert.equal(args.includes("features.apps=false"), false);
  assert.equal(args.includes("features.remote_plugin=false"), false);
  assert.equal(args.includes("features.memories=false"), false);
  assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
  assert.equal(args.at(-1), NEUTRAL_PROMPT);
  const allowlist = args.find((argument) =>
    argument.startsWith("mcp_servers.parabox.enabled_tools="),
  );
  assert.equal(
    allowlist,
    'mcp_servers.parabox.enabled_tools=["observe_game","press_keys","challenge_time","challenge_tokens"]',
  );
  assert.ok(
    args.includes('mcp_servers.parabox.default_tools_approval_mode="approve"'),
  );
  assert.equal(args.some((argument) => argument.includes("view_image")), false);
});

test("passes the selected credential home through the local Codex launcher", () => {
  const env = codexEnvironment("/credentials/codex");
  assert.equal(env.CODEX_HOME, "/credentials/codex");
  assert.equal(env.CODEX_HOME_OVERRIDE, "/credentials/codex");
  assert.equal(env.CODEX_PROXY_HOME, "/credentials/codex");
});

test("resumes the same Codex thread with the constrained continuation prompt", () => {
  const args = codexArguments({
    mcpEntry: "/arena/mcp.js",
    arenaUrl: "http://127.0.0.1:4317",
    controlToken: "secret",
    reasoningEffort: "high",
    resumeThreadId: "00000000-0000-0000-0000-000000000001",
  });
  assert.deepEqual(args.slice(-3), [
    "resume",
    "00000000-0000-0000-0000-000000000001",
    RESUME_PROMPT,
  ]);
});

test("recognizes common quota exhaustion errors without matching generic failures", () => {
  assert.equal(isQuotaError("unexpected status 429 Too Many Requests"), true);
  assert.equal(isQuotaError("You've hit your usage limit"), true);
  assert.equal(isQuotaError("insufficient_quota"), true);
  assert.equal(isQuotaError("quota snapshot saved successfully"), false);
  assert.equal(isQuotaError("connection reset by peer"), false);
});

test("extracts the reset deadline printed in quota errors", () => {
  const now = new Date(2026, 8, 7, 7, 0, 0).getTime();
  assert.equal(
    extractQuotaResetAtFromText("You've hit your usage limit; try again at 8:28 AM.", now),
    new Date(2026, 8, 7, 8, 28, 0).getTime(),
  );
  assert.equal(
    extractQuotaResetAtFromText(
      "You've hit your usage limit; try again at Sep 12th, 2026 10:24 PM.",
      now,
    ),
    new Date(2026, 8, 12, 22, 24, 0).getTime(),
  );
  assert.equal(
    extractQuotaResetAtFromText("unexpected status 401 Unauthorized", now),
    null,
  );
});

test("uses the exhausted Codex window reset with a one-minute grace period", () => {
  const resetAt = extractQuotaResetAt({
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: {
          used_percent: 99,
          window_minutes: 300,
          resets_at: 1_800_000_000,
        },
        secondary: {
          used_percent: 94,
          window_minutes: 10_080,
          resets_at: 1_800_500_000,
        },
        rate_limit_reached_type: "primary",
      },
    },
  });
  assert.equal(resetAt, 1_800_000_000_000);
  assert.equal(
    quotaRetryAt(1_799_999_000_000, 18_000_000, resetAt),
    "2027-01-15T08:01:00.000Z",
  );
});

test("waits for the later reset when multiple quota windows are exhausted", () => {
  const resetAt = extractQuotaResetAt({
    type: "event_msg",
    payload: {
      rate_limits: {
        primary: { used_percent: 100, resets_at: 1_800_000_000 },
        secondary: { used_percent: 100, resets_at: 1_800_500_000 },
        rate_limit_reached_type: "primary",
      },
    },
  });
  assert.equal(resetAt, 1_800_500_000_000);
  assert.equal(
    extractQuotaResetAt({
      payload: {
        rate_limits: {
          primary: { used_percent: 71, resets_at: 1_800_000_000 },
          secondary: { used_percent: 94, resets_at: 1_800_500_000 },
        },
      },
    }),
    null,
  );
});

test("falls back to the configured wait when Codex provides no reset", () => {
  assert.equal(
    quotaRetryAt(1_800_000_000_000, 18_000_000, null),
    "2027-01-15T13:00:00.000Z",
  );
});
