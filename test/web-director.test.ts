import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("director bootstrap uses the internal controller event and supervisor surfaces", async () => {
  const script = await readFile(path.resolve("web/app.js"), "utf8");

  assert.match(script, /const initialBroadcast = broadcast \? refreshBroadcast\(\) : null/);
  assert.match(script, /await Promise\.all\(\[\s*refreshSupervisor\(\),\s*initialBroadcast \|\| refreshBroadcast\(\)/);
  assert.match(script, /state\.supervisor = await fetch\("\/api\/supervisor"/);
  assert.match(script, /const apiKeyActive = credential\?\.mode === "api-key"/);
  assert.match(script, /OAUTH POOL INACTIVE/);
  assert.match(script, /if \(director \|\| broadcast\) byId\("frame-time"\)\.textContent = "LIVE · 30 FPS"/);
  assert.match(script, /const events = new EventSource\("\/api\/events"\)/);
  assert.match(script, /events\.addEventListener\("state"/);
  assert.match(script, /events\.addEventListener\("transcript"/);
  assert.match(script, /events\.addEventListener\("frame"/);
  assert.match(script, /events\.addEventListener\("broadcast"/);
  assert.match(script, /\/api\/live-audio\.ogg/);
  assert.match(script, /\/api\/music\/audio\.ogg/);
  assert.match(script, /events\.addEventListener\("music"/);
  assert.match(script, /checkMusicAudioProgress/);
  assert.match(script, /Date\.now\(\) - state\.musicAudioLastProgressAt > 12_000/);
  assert.match(script, /updateMusicOverlays/);
  assert.match(script, /replay\.mjpeg/);
  assert.match(script, /replay-audio\.ogg/);
  assert.match(script, /回放画面流中断，正在重连/);
  assert.match(script, /configured\.webSearchEnabled === true/);
  assert.match(script, /configured\.browserUseEnabled === true/);
  assert.match(script, /toolCreationGuidance: byId\("tool-guidance-toggle"\)\.checked/);
});
