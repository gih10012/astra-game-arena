import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  mkdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODEX_COMMAND,
  codexEnvironment,
  credentialAfterModelChange,
  isHistoricalUnsupportedChatGptModel,
  isChatGptModelUnsupportedError,
  prepareApiKeyRuntimeHome,
  publicApiKeyCredential,
  resolveApiKeyCredential,
} from "../src/codex-home.js";

test("discovers API-key credentials without returning or exposing the key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-home-api-key-"));
  const secret = "sk-test-do-not-leak";
  try {
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "auth.json"),
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: secret }),
    );
    await writeFile(path.join(root, "config.toml"), 'model_provider = "openai"\n');

    const credential = await resolveApiKeyCredential(root);
    assert.deepEqual(credential, {
      mode: "api-key",
      provider: "openai",
      home: path.resolve(root),
      label: "openai API key",
    });
    assert.equal(JSON.stringify(credential).includes(secret), false);
    assert.equal(Object.values(credential ?? {}).includes(secret), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not classify ChatGPT authentication as an API-key credential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-home-chatgpt-"));
  try {
    await writeFile(
      path.join(root, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "chatgpt-token" },
      }),
    );
    await writeFile(path.join(root, "config.toml"), 'model_provider = "openai"\n');

    assert.equal(await resolveApiKeyCredential(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepares a private API-key runtime home outside run artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-home-runtime-"));
  const source = path.join(root, "source");
  const project = path.join(root, "project");
  const runtime = path.join(root, "private-state", "codex");
  try {
    await mkdir(source, { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(source, "auth.json"),
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-private" }),
    );
    await writeFile(path.join(source, "config.toml"), 'model_provider = "custom"\n');
    const credential = await resolveApiKeyCredential(source);
    assert.ok(credential);

    assert.equal(
      await prepareApiKeyRuntimeHome(credential, runtime, [project]),
      runtime,
    );
    assert.equal((await lstat(runtime)).mode & 0o777, 0o700);
    assert.equal((await lstat(path.join(runtime, "auth.json"))).isSymbolicLink(), true);
    assert.equal(
      path.resolve(runtime, await readlink(path.join(runtime, "auth.json"))),
      path.join(source, "auth.json"),
    );
    await assert.rejects(
      prepareApiKeyRuntimeHome(credential, path.join(project, "run", "credential"), [project]),
      /outside the project and run directories/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a real model change clears the API-key fallback", () => {
  const apiKey = publicApiKeyCredential({
    mode: "api-key",
    provider: "custom",
    home: "/private/credential-source",
    label: "custom API key",
  });
  assert.deepEqual(
    credentialAfterModelChange(apiKey, "gpt-6-astra", "gpt-5.6-sol"),
    {
      mode: "chatgpt-pool",
      provider: "openai",
      label: "ChatGPT account pool",
    },
  );
  assert.deepEqual(
    credentialAfterModelChange(apiKey, "gpt-6-astra", "gpt-6-astra"),
    apiKey,
  );
});

test("detects generic unsupported-model errors for ChatGPT accounts", () => {
  assert.equal(
    isChatGptModelUnsupportedError(
      "The selected model is not supported for this ChatGPT account.",
    ),
    true,
  );
  assert.equal(
    isChatGptModelUnsupportedError(
      "MODEL is NOT SUPPORTED when using Codex with a ChatGPT account",
    ),
    true,
  );
  assert.equal(
    isChatGptModelUnsupportedError("The model is not supported for this API account."),
    false,
  );
});

test("restores fallback only when a persisted diagnostic names the current model", () => {
  const diagnostic =
    "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.";
  assert.equal(
    isHistoricalUnsupportedChatGptModel(diagnostic, "gpt-6-astra"),
    true,
  );
  assert.equal(
    isHistoricalUnsupportedChatGptModel(diagnostic, "gpt-5.6-sol"),
    false,
  );
});

test("provides local HTTP and SOCKS proxy defaults in both variable cases", () => {
  const savedHttpProxy = process.env.ASTRA_CODEX_HTTP_PROXY;
  const savedSocksProxy = process.env.ASTRA_CODEX_SOCKS_PROXY;
  try {
    delete process.env.ASTRA_CODEX_HTTP_PROXY;
    delete process.env.ASTRA_CODEX_SOCKS_PROXY;

    const environment = codexEnvironment(undefined);
    assert.equal(CODEX_COMMAND, "codex-proxy");
    assert.equal(environment.HTTP_PROXY, "http://127.0.0.1:7890");
    assert.equal(environment.HTTPS_PROXY, "http://127.0.0.1:7890");
    assert.equal(environment.http_proxy, "http://127.0.0.1:7890");
    assert.equal(environment.https_proxy, "http://127.0.0.1:7890");
    assert.equal(environment.ALL_PROXY, "socks5h://127.0.0.1:7890");
    assert.equal(environment.all_proxy, "socks5h://127.0.0.1:7890");
  } finally {
    if (savedHttpProxy === undefined) delete process.env.ASTRA_CODEX_HTTP_PROXY;
    else process.env.ASTRA_CODEX_HTTP_PROXY = savedHttpProxy;
    if (savedSocksProxy === undefined) delete process.env.ASTRA_CODEX_SOCKS_PROXY;
    else process.env.ASTRA_CODEX_SOCKS_PROXY = savedSocksProxy;
  }
});
