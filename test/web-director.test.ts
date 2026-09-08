import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("director bootstrap uses the internal controller event and supervisor surfaces", async () => {
  const script = await readFile(path.resolve("web/app.js"), "utf8");

  assert.match(script, /if \(!compact\) \{\s*if \(!director\) await loadOptions\(\);\s*await refreshSupervisor\(\);/);
  assert.match(script, /state\.supervisor = await fetch\("\/api\/supervisor"/);
  assert.match(script, /const apiKeyActive = credential\?\.mode === "api-key"/);
  assert.match(script, /OAUTH POOL INACTIVE/);
  assert.match(script, /if \(director\) byId\("frame-time"\)\.textContent = "LIVE · 30 FPS"/);
  assert.match(script, /const events = new EventSource\("\/api\/events"\)/);
  assert.match(script, /events\.addEventListener\("state"/);
  assert.match(script, /events\.addEventListener\("transcript"/);
  assert.match(script, /events\.addEventListener\("frame"/);
  assert.match(script, /configured\.webSearchEnabled === true/);
  assert.match(script, /configured\.browserUseEnabled === true/);
  assert.match(script, /toolCreationGuidance: byId\("tool-guidance-toggle"\)\.checked/);
});
