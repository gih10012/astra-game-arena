import { constants } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TOOL_APP_IDS = new Set(["1070560", "1391110", "1493710", "228980", "4183110"]);
const TOOL_NAME = /(?:proton|steam linux runtime|steamworks common redistributables|redistributable)/i;

export interface InstalledSteamGame {
  appId: string;
  name: string;
  installDirectory: string;
  executable: string;
  platform: "windows" | "linux";
  manifest: string;
}

interface SteamManifest {
  appid?: string;
  name?: string;
  installdir?: string;
}

export async function discoverInstalledSteamGames(): Promise<InstalledSteamGame[]> {
  const libraries = await discoverSteamLibraries();
  const games: InstalledSteamGame[] = [];
  const seen = new Set<string>();
  for (const library of libraries) {
    const steamapps = path.join(library, "steamapps");
    const entries = await readdir(steamapps, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !/^appmanifest_\d+\.acf$/i.test(entry.name)) continue;
      const manifest = path.join(steamapps, entry.name);
      const parsed = parseSteamManifest(await readFile(manifest, "utf8").catch(() => ""));
      const appId = parsed.appid ?? /appmanifest_(\d+)\.acf/i.exec(entry.name)?.[1];
      if (!appId || seen.has(appId) || TOOL_APP_IDS.has(appId)) continue;
      const name = parsed.name?.trim();
      const installName = parsed.installdir?.trim();
      if (!name || !installName || TOOL_NAME.test(name)) continue;
      const installDirectory = path.join(steamapps, "common", installName);
      const executable = await chooseExecutable(installDirectory, name, installName);
      if (!executable) continue;
      seen.add(appId);
      games.push({
        appId,
        name,
        installDirectory,
        executable,
        platform: executable.toLowerCase().endsWith(".exe") ? "windows" : "linux",
        manifest,
      });
    }
  }
  return games.sort((left, right) => left.name.localeCompare(right.name));
}

export async function findInstalledSteamGame(appId: string): Promise<InstalledSteamGame> {
  const game = (await discoverInstalledSteamGames()).find((entry) => entry.appId === appId);
  if (!game) throw new Error(`Steam app ${appId} is not installed or has no launchable executable`);
  return game;
}

export function parseSteamManifest(text: string): SteamManifest {
  const result: SteamManifest = {};
  for (const key of ["appid", "name", "installdir"] as const) {
    const match = new RegExp(`"${key}"\\s+"([^"]*)"`, "i").exec(text);
    if (match?.[1]) result[key] = match[1];
  }
  return result;
}

async function discoverSteamLibraries(): Promise<string[]> {
  const homeSteam = path.join(os.homedir(), ".local/share/Steam");
  const candidates = new Set([
    homeSteam,
    "/share/SteamLibrary",
    "/windows/Program Files (x86)/Steam",
  ]);
  for (const root of [...candidates]) {
    const libraryFile = path.join(root, "steamapps/libraryfolders.vdf");
    const text = await readFile(libraryFile, "utf8").catch(() => "");
    for (const match of text.matchAll(/"path"\s+"([^"]+)"/gi)) {
      if (match[1]) candidates.add(match[1].replaceAll("\\\\", "\\"));
    }
  }
  const available: string[] = [];
  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, "steamapps"), constants.R_OK);
      available.push(path.resolve(candidate));
    } catch {
      // Ignore Steam libraries that are currently unmounted.
    }
  }
  return [...new Set(available)];
}

async function chooseExecutable(
  installDirectory: string,
  gameName: string,
  installName: string,
): Promise<string | null> {
  const files = await executableCandidates(installDirectory, 0);
  const wanted = normalize(`${gameName} ${installName}`);
  const ranked = await Promise.all(files.map(async (filename) => {
    const basename = path.basename(filename, path.extname(filename));
    const normalized = normalize(basename);
    const extension = path.extname(filename).toLowerCase();
    const nativeCandidate = extension === "" || extension === ".x86_64" || extension === ".appimage" || extension === ".sh";
    const executable = extension === ".exe" || (nativeCandidate && await isExecutable(filename));
    if (!executable || /crash|unins|redist|report|unityplayer|setup|launcherhelper/i.test(basename)) {
      return null;
    }
    const info = await stat(filename).catch(() => null);
    const nameScore = normalized.length >= 3 && wanted.includes(normalized) ? 10_000 : 0;
    const rootScore = path.dirname(filename) === installDirectory ? 2_000 : 0;
    const launcherPenalty = /launcher/i.test(basename) ? -500 : 0;
    const depthPenalty = filename.slice(installDirectory.length).split(path.sep).length * 25;
    const sizeScore = Math.min(1_000, Math.log2(Math.max(1, info?.size ?? 1)) * 35);
    return { filename, score: nameScore + rootScore + launcherPenalty + sizeScore - depthPenalty };
  }));
  return ranked
    .filter((entry): entry is { filename: string; score: number } => entry !== null)
    .sort((left, right) => right.score - left.score)[0]?.filename ?? null;
}

async function executableCandidates(directory: string, depth: number): Promise<string[]> {
  if (depth > 5) return [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!/redist|support|manual|soundtrack|localization/i.test(entry.name)) {
        results.push(...await executableCandidates(filename, depth + 1));
      }
    } else if (entry.isFile()) {
      const extension = path.extname(entry.name).toLowerCase();
      if (extension === ".exe" || extension === ".x86_64" || extension === ".appimage" || extension === ".sh" || extension === "") {
        results.push(filename);
      }
    }
  }
  return results;
}

async function isExecutable(filename: string): Promise<boolean> {
  try {
    await access(filename, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, "");
}
