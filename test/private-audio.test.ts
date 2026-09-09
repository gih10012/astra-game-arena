import assert from "node:assert/strict";
import test from "node:test";
import { privateAudioNodeNames } from "../src/private-audio.js";

test("private game audio uses run-specific PipeWire-safe names", () => {
  const names = privateAudioNodeNames("2026-09-09T00:12:34.567Z-ABC");
  assert.match(names.sink, /^astra_game_audio_[a-z0-9_]+$/);
  assert.match(names.microphone, /^astra_game_microphone_[a-z0-9_]+$/);
  assert.notEqual(names.sink, names.microphone);
});
