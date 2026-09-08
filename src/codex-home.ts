import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CODEX_COMMAND = "codex-proxy";

export interface ApiKeyCredential {
  mode: "api-key";
  provider: string;
  home: string;
  label: string;
}

export interface PublicCodexCredential {
  mode: "chatgpt-pool" | "api-key";
  provider: string;
  label: string;
}

export const CHATGPT_POOL_CREDENTIAL: PublicCodexCredential = {
  mode: "chatgpt-pool",
  provider: "openai",
  label: "ChatGPT account pool",
};

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
  const httpProxy = process.env.ASTRA_CODEX_HTTP_PROXY ?? "http://127.0.0.1:7890";
  const socksProxy = process.env.ASTRA_CODEX_SOCKS_PROXY ?? "socks5h://127.0.0.1:7890";
  return {
    ...process.env,
    HTTP_PROXY: httpProxy,
    HTTPS_PROXY: httpProxy,
    http_proxy: httpProxy,
    https_proxy: httpProxy,
    ALL_PROXY: socksProxy,
    all_proxy: socksProxy,
    ...(codexHome
      ? {
        CODEX_HOME: codexHome,
        // The local Codex launcher honors this before exporting CODEX_HOME.
        CODEX_HOME_OVERRIDE: codexHome,
        // codex-proxy uses this for the official authenticated profile.
        CODEX_PROXY_HOME: codexHome,
        // Keep conversation rollouts and the thread index shared across account profiles.
        ...(baseCodexHome ? { CODEX_BASE_HOME: baseCodexHome } : {}),
      }
      : {}),
  };
}

export async function resolveApiKeyCredential(
  home = path.join(os.homedir(), ".codex"),
): Promise<ApiKeyCredential | null> {
  const resolved = path.resolve(home);
  try {
    const auth = JSON.parse(await readFile(path.join(resolved, "auth.json"), "utf8")) as {
      auth_mode?: unknown;
      OPENAI_API_KEY?: unknown;
    };
    if (
      auth.auth_mode !== "apikey" ||
      typeof auth.OPENAI_API_KEY !== "string" ||
      auth.OPENAI_API_KEY.length === 0
    ) {
      return null;
    }
    const provider = configuredModelProvider(
      await readFile(path.join(resolved, "config.toml"), "utf8"),
    );
    if (!provider) return null;
    return {
      mode: "api-key",
      provider,
      home: resolved,
      label: `${provider} API key`,
    };
  } catch {
    return null;
  }
}

export async function prepareApiKeyRuntimeHome(
  credential: ApiKeyCredential,
  runtimeHome: string,
  forbiddenRoots: readonly string[] = [],
): Promise<string> {
  const resolved = path.resolve(runtimeHome);
  for (const root of forbiddenRoots) {
    if (pathContains(path.resolve(root), resolved)) {
      throw new Error("The API-key runtime home must be outside the project and run directories");
    }
  }
  try {
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    await chmod(resolved, 0o700);
  } catch {
    throw new Error("Could not create the private API-key runtime home");
  }
  await Promise.all(
    ["auth.json", "config.toml"].map(async (name) => {
      const source = path.join(credential.home, name);
      const destination = path.join(resolved, name);
      try {
        await access(source);
      } catch {
        throw new Error(`The API-key credential ${name} is unavailable`);
      }
      try {
        const info = await lstat(destination);
        if (!info.isSymbolicLink()) {
          throw new Error(`Refusing to replace the API-key runtime ${name}`);
        }
        const linked = await readlink(destination);
        if (path.resolve(resolved, linked) !== source) {
          throw new Error(`The API-key runtime ${name} has an unexpected target`);
        }
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        await symlink(source, destination);
      }
    }),
  ).catch((error: unknown) => {
    if (
      error instanceof Error &&
      /^(?:The API-key|Refusing to replace the API-key)/.test(error.message)
    ) {
      throw error;
    }
    throw new Error("Could not prepare the API-key runtime home");
  });
  return resolved;
}

export function apiKeyRuntimeHome(
  runtimeRoot = process.env.ASTRA_CODEX_RUNTIME_ROOT ??
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.resolve(runtimeRoot, `astra-game-arena-${uid}`, "codex-api-key");
}

export function publicApiKeyCredential(
  credential: ApiKeyCredential,
): PublicCodexCredential {
  return {
    mode: "api-key",
    provider: credential.provider,
    label: credential.label,
  };
}

export function credentialAfterModelChange(
  credential: PublicCodexCredential,
  currentModel: string | undefined,
  nextModel: string | undefined,
): PublicCodexCredential {
  return nextModel !== undefined && nextModel !== currentModel
    ? { ...CHATGPT_POOL_CREDENTIAL }
    : { ...credential };
}

export function isChatGptModelUnsupportedError(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes("model is not supported when using codex with a chatgpt account") ||
    (/not supported/.test(normalized) &&
      /chatgpt account/.test(normalized) &&
      /model/.test(normalized));
}

export function isHistoricalUnsupportedChatGptModel(
  text: string,
  model: string,
): boolean {
  if (!isChatGptModelUnsupportedError(text)) return false;
  return text.toLowerCase().includes(model.trim().toLowerCase());
}

export function displayCodexHome(codexHome: string | undefined): string {
  if (!codexHome) return "default (~/.codex)";
  const home = os.homedir();
  return codexHome === home || codexHome.startsWith(`${home}${path.sep}`)
    ? `~${codexHome.slice(home.length)}`
    : codexHome;
}

function configuredModelProvider(config: string): string | null {
  for (const rawLine of config.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (line.startsWith("[")) break;
    const match = /^model_provider\s*=\s*(?:"([^"]+)"|'([^']+)')\s*$/.exec(line);
    const provider = match?.[1] ?? match?.[2];
    if (provider && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(provider)) return provider;
  }
  return null;
}

function stripTomlComment(line: string): string {
  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if ((character === "\"" || character === "'") && line[index - 1] !== "\\") {
      quote = quote === character ? null : quote ?? character;
    } else if (character === "#" && quote === null) {
      return line.slice(0, index);
    }
  }
  return line;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
