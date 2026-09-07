import assert from "node:assert/strict";
import test from "node:test";
import { parseSteamManifest } from "../src/steam-catalog.js";

test("parses the installed app identity from a Steam manifest", () => {
  assert.deepEqual(parseSteamManifest(`"AppState"
{
  "appid" "1260520"
  "name" "Patrick's Parabox"
  "installdir" "Patrick's Parabox"
}`), {
    appid: "1260520",
    name: "Patrick's Parabox",
    installdir: "Patrick's Parabox",
  });
});
