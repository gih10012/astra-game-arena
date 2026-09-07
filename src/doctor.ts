import { access, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverCodexAccounts } from "./account-pool.js";
import {
  CODEX_COMMAND,
  codexEnvironment,
  displayCodexHome,
  resolveCodexHome,
} from "./codex-home.js";
import { runCommand } from "./command.js";
import { parseParaboxSave } from "./save-parser.js";
import { TARGET_LEVELS } from "./types.js";
import { discoverInstalledSteamGames } from "./steam-catalog.js";
import { discoverVirtualCameraDevices } from "./virtual-camera.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

export function defaultGamePaths() {
  const steam = path.join(os.homedir(), ".local/share/Steam");
  const libraryRoots = [
    steam,
    "/share/SteamLibrary",
    "/windows/Program Files (x86)/Steam",
  ];
  const library =
    libraryRoots.find((root) =>
      existsSync(path.join(root, "steamapps/appmanifest_1260520.acf")),
    ) ?? steam;
  return {
    manifest: path.join(library, "steamapps/appmanifest_1260520.acf"),
    executable: path.join(
      library,
      "steamapps/common/Patrick's Parabox/Patrick's Parabox.exe",
    ),
    saveDirectory: path.join(
      steam,
      "steamapps/compatdata/1260520/pfx/drive_c/users/steamuser/AppData/LocalLow/Patrick Traynor/Patrick's Parabox",
    ),
  };
}

async function commandCheck(command: string, required = true): Promise<DoctorCheck> {
  const result = await runCommand("which", [command]);
  return {
    name: command,
    ok: result.code === 0,
    detail:
      result.code === 0 ? result.stdout.toString("utf8").trim() : "not found",
    required,
  };
}

async function commandOrFileCheck(
  command: string,
  fallback: string,
  required = true,
): Promise<DoctorCheck> {
  const commandResult = await commandCheck(command, required);
  if (commandResult.ok) return commandResult;
  const fileResult = await fileCheck(command, fallback, required);
  return fileResult.ok
    ? { ...fileResult, detail: `${fallback} (project-local runtime)` }
    : commandResult;
}

async function fileCheck(
  name: string,
  filename: string,
  required = true,
): Promise<DoctorCheck> {
  try {
    await access(filename);
    return { name, ok: true, detail: filename, required };
  } catch {
    return { name, ok: false, detail: `missing: ${filename}`, required };
  }
}

export async function runDoctor(options: { codexHome?: string } = {}): Promise<DoctorCheck[]> {
  const paths = defaultGamePaths();
  const codexHome = await resolveCodexHome(options.codexHome);
  const codexEnv = codexEnvironment(codexHome);
  const checks = await Promise.all([
    commandCheck("node"),
    commandCheck(CODEX_COMMAND),
    commandCheck("ffmpeg"),
    commandCheck("xprop"),
    commandCheck("cc"),
    commandOrFileCheck(
      "Xvfb",
      path.resolve(".arena/tools/xvfb-root/usr/bin/Xvfb"),
    ),
    commandOrFileCheck(
      "cage",
      path.resolve(".arena/tools/cage-root/usr/bin/cage"),
    ),
    commandCheck("wlr-randr"),
    commandCheck("grim"),
    commandCheck("wf-recorder"),
    commandCheck("google-chrome-stable"),
    commandCheck("steam"),
    fileCheck("Parabox manifest adapter", paths.manifest, false),
    fileCheck("Parabox executable adapter", paths.executable, false),
    fileCheck("Parabox save adapter", paths.saveDirectory, false),
  ]);

  const installedGames = await discoverInstalledSteamGames();
  checks.push({
    name: "launchable Steam games",
    ok: installedGames.length > 0,
    detail: `${installedGames.length} candidate(s) detected`,
    required: true,
  });

  const virtualCameras = await discoverVirtualCameraDevices();
  checks.push({
    name: "V4L2 virtual camera (optional)",
    ok: virtualCameras.some((camera) => camera.writable),
    detail: virtualCameras.length > 0
      ? virtualCameras.map((camera) =>
          `${camera.device} (${camera.label}, ${camera.writable ? "writable" : "not writable"})`
        ).join(", ")
      : "not configured; install/load v4l2loopback to enable OBS/meeting output",
    required: false,
  });

  const loginResult = await runCommand(CODEX_COMMAND, ["login", "status"], {
    env: codexEnv,
  });
  checks.push({
    name: "Codex credentials",
    ok: loginResult.code === 0,
    detail:
      loginResult.code === 0
        ? `authenticated via ${displayCodexHome(codexHome)}`
        : `not authenticated via ${displayCodexHome(codexHome)}`,
    required: true,
  });

  const accountProfiles = await discoverCodexAccounts();
  checks.push({
    name: "Codex account pool",
    ok: accountProfiles.length >= 2,
    detail: accountProfiles.length > 0
      ? `${accountProfiles.length} isolated profile(s): ${accountProfiles.map((profile) => path.basename(profile.home)).join(", ")}`
      : "disabled (no isolated profiles)",
    required: false,
  });

  const modelResult = await runCommand(CODEX_COMMAND, ["debug", "models", "--bundled"], {
    env: codexEnv,
  });
  let modelOk = false;
  if (modelResult.code === 0) {
    try {
      const text = modelResult.stdout.toString("utf8");
      modelOk = text.includes('"gpt-6-astra"');
    } catch {
      modelOk = false;
    }
  }
  checks.push({
    name: "gpt-6-astra model",
    ok: modelOk,
    detail: modelOk ? "present in bundled Codex catalog" : "not in model catalog",
    required: true,
  });

  const saveNames = ["save0.txt", "save1.txt", "save2.txt"];
  let detectedTotal = 0;
  for (const name of saveNames) {
    try {
      const progress = parseParaboxSave(
        await readFile(path.join(paths.saveDirectory, name), "utf8"),
      );
      detectedTotal = Math.max(detectedTotal, progress.total);
    } catch {
      // A missing slot is normal.
    }
  }
  checks.push({
    name: "Parabox official level catalog",
    ok: detectedTotal === TARGET_LEVELS,
    detail: `${detectedTotal}/${TARGET_LEVELS} entries detected in local save format`,
    required: false,
  });

  return checks;
}
