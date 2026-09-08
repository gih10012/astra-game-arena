import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CODEX_COMMAND = "codex-proxy";

export async function resolveCodexHome(
  explicitHome?: string,
): Promise<string | undefined> {
  const configured = explicitHome ?? process.env.ASTRA_CODEX_HOME;
  if (configured) {
    const resolved = path.resolve(configured);
    await access(path.join(resolved, "auth.json"));
    return resolved;
  }

  const officialHome = path.join(os.homedir(), ".codex-official");
  try {
    await access(path.join(officialHome, "auth.json"));
    return officialHome;
  } catch {
    return process.env.CODEX_HOME
      ? path.resolve(process.env.CODEX_HOME)
      : undefined;
  }
}

export function codexEnvironment(
  codexHome: string | undefined,
  baseCodexHome?: string,
): NodeJS.ProcessEnv {
  return codexHome
    ? {
        ...process.env,
        CODEX_HOME: codexHome,
        // The local Codex launcher honors this before exporting CODEX_HOME.
        CODEX_HOME_OVERRIDE: codexHome,
        // codex-proxy uses this for the official authenticated profile.
        CODEX_PROXY_HOME: codexHome,
        // Keep conversation rollouts and the thread index shared across account profiles.
        ...(baseCodexHome ? { CODEX_BASE_HOME: baseCodexHome } : {}),
      }
    : process.env;
}

export function displayCodexHome(codexHome: string | undefined): string {
  if (!codexHome) return "default (~/.codex)";
  const home = os.homedir();
  return codexHome === home || codexHome.startsWith(`${home}${path.sep}`)
    ? `~${codexHome.slice(home.length)}`
    : codexHome;
}
