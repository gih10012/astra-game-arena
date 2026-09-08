const byId = (id) => document.getElementById(id);
const compact = new URLSearchParams(location.search).get("compact") === "1";
const director = new URLSearchParams(location.search).get("director") === "1";
const state = {
  snapshot: null,
  supervisor: null,
  options: null,
  localReceivedAt: 0,
  transcriptSequences: new Set(),
  itemRows: new Map(),
  livePreviewDevice: null,
};

if (compact) document.body.classList.add("compact");
if (director) document.body.classList.add("director");
if (director) byId("frame-time").textContent = "LIVE · 30 FPS";

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function formatElapsed(milliseconds) {
  const value = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  const millis = value % 1_000;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":") +
    `.${String(millis).padStart(3, "0")}`;
}

function applySnapshot(snapshot) {
  state.snapshot = snapshot;
  state.localReceivedAt = performance.now();
  byId("tokens").textContent = formatNumber(snapshot.tokens?.totalTokens);
  byId("token-breakdown").textContent =
    `${formatNumber(snapshot.tokens?.inputTokens)} in · ${formatNumber(snapshot.tokens?.outputTokens)} out`;
  byId("model").textContent = String(snapshot.model || "—").toUpperCase();
  const phase = snapshot.phase || snapshot.status || "idle";
  byId("status").textContent = String(phase).replaceAll("_", " ").toUpperCase();
  byId("game-name").textContent = snapshot.game?.name || "NO RUN";
  byId("goal-summary").textContent = snapshot.goal || "configure a challenge";
  byId("run-id").textContent = snapshot.runId
    ? `${snapshot.runId} · PART ${String(snapshot.attempt || 1).padStart(4, "0")}`
    : "not started";
  updateControls();
}

function tick() {
  if (state.snapshot) {
    const phase = state.snapshot.phase || state.snapshot.status;
    const runningDelta = phase === "running" ? performance.now() - state.localReceivedAt : 0;
    byId("elapsed").textContent = formatElapsed((state.snapshot.time?.elapsedMs || 0) + runningDelta);
  }
  requestAnimationFrame(tick);
}

function stringify(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

function addText(container, text, className = "") {
  if (text === undefined || text === null || text === "") return;
  const paragraph = document.createElement("p");
  paragraph.className = className;
  paragraph.textContent = String(text);
  container.append(paragraph);
}

function addCode(container, label, value, className = "") {
  if (value === undefined || value === null || value === "") return;
  const block = document.createElement("div");
  block.className = `event-detail ${className}`.trim();
  if (label) {
    const heading = document.createElement("span");
    heading.textContent = label;
    block.append(heading);
  }
  const code = document.createElement("pre");
  const text = stringify(value);
  const lines = text.split("\n");
  code.textContent = lines.length > 18
    ? [...lines.slice(0, 11), `… +${lines.length - 15} lines`, ...lines.slice(-4)].join("\n")
    : text;
  if (lines.length > 18) code.title = text;
  block.append(code);
  container.append(block);
}

function parseToolResultText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content.find((entry) => entry?.type === "text")?.text;
  if (typeof text !== "string") return null;
  try { return JSON.parse(text); } catch { return text; }
}

function conciseToolDetails(item) {
  const parsed = parseToolResultText(item.result);
  if (item.tool === "observe_screen") {
    return [["FRAME", parsed ? `${parsed.capturedAt || "captured"} · sha256 ${String(parsed.sha256 || "").slice(0, 16)}…` : "Captured"]];
  }
  if (item.tool === "press_keys") {
    const keys = Array.isArray(item.arguments?.keys) ? item.arguments.keys : [];
    return [
      ["KEYS", `${keys.slice(0, 30).join(" ")}${keys.length > 30 ? ` … +${keys.length - 30}` : ""}`],
      ["RESULT", parsed ?? item.result, "output"],
      ["ERROR", item.error, "error-text"],
    ];
  }
  if (item.tool === "mouse") {
    return [["ACTION", item.arguments], ["RESULT", parsed ?? item.result, "output"], ["ERROR", item.error, "error-text"]];
  }
  if (item.tool === "type_text") {
    return [["TEXT", item.arguments?.text], ["RESULT", parsed ?? item.result, "output"], ["ERROR", item.error, "error-text"]];
  }
  return [["ARGS", item.arguments], ["RESULT", parsed ?? item.result, "output"], ["ERROR", item.error, "error-text"]];
}

function eventPresentation(event) {
  const item = event.item && typeof event.item === "object" ? event.item : null;
  const itemType = item?.type || "";
  const eventType = event.type || "event";
  const status = item?.status || "";
  const complete = eventType === "item.completed" || status === "completed";
  const failed = eventType.includes("error") || itemType === "error" || status === "failed";
  if (itemType === "agent_message") return { label: "CODEX", kind: "agent", title: item.text || "" };
  if (itemType === "reasoning") return { label: "THINK", kind: "reasoning", title: item.text || "" };
  if (itemType === "command_execution") {
    return {
      label: "SHELL", kind: failed ? "error" : "tool",
      title: `${complete ? "Ran" : "Running"} ${item.command || "command"}`,
      details: [["OUTPUT", item.aggregated_output, "output"], ["EXIT", item.exit_code, item.exit_code ? "error-text" : ""]],
    };
  }
  if (itemType === "mcp_tool_call") {
    const name = `${item.server || "mcp"}.${item.tool || item.name || "tool"}`;
    return { label: "TOOL", kind: failed ? "error" : "tool", title: `${complete ? "Called" : "Calling"} ${name}`, details: conciseToolDetails(item) };
  }
  if (itemType === "error") return { label: "ERROR", kind: "error", title: item.message || stringify(item) };
  if (item) {
    const remaining = Object.fromEntries(Object.entries(item).filter(([key]) => !["id", "type", "status", "text"].includes(key)));
    return {
      label: itemType.slice(0, 7).toUpperCase() || "ITEM", kind: failed ? "error" : "system",
      title: item.text || `${eventType} · ${itemType || "item"}`,
      details: Object.keys(remaining).length ? [["DETAIL", remaining]] : [],
    };
  }
  if (eventType === "thread.started") return { label: "THREAD", kind: "system", title: "Thread started", details: [["ID", event.thread_id]] };
  if (eventType === "turn.started") return { label: "TURN", kind: "system", title: "Turn started" };
  if (eventType === "turn.completed") return { label: "TURN", kind: "success", title: "Turn completed", details: [["USAGE", event.usage]] };
  if (eventType === "stderr") return { label: "STDERR", kind: "error", title: event.message || "stderr" };
  if (eventType === "error" || eventType === "runner.error") return { label: "ERROR", kind: "error", title: event.message || stringify(event) };
  if (eventType === "process.started") return { label: "PROC", kind: "system", title: `Started ${event.process}` };
  if (eventType === "process.exited") return { label: "PROC", kind: event.code === 0 ? "success" : "error", title: `${event.process} exited (code=${event.code}, signal=${event.signal})` };
  if (eventType === "runner.ready") return { label: "SYS", kind: "success", title: event.message };
  if (eventType === "challenge.completed") return { label: "DONE", kind: "success", title: event.message };
  const remaining = Object.fromEntries(Object.entries(event).filter(([key]) => key !== "type"));
  return { label: eventType.slice(0, 7).toUpperCase(), kind: failed ? "error" : "system", title: event.message || eventType, details: Object.keys(remaining).length ? [["DETAIL", remaining]] : [] };
}

function renderTranscriptRow(row, event) {
  const presentation = eventPresentation(event);
  row.className = `event ${presentation.kind}`;
  row.replaceChildren();
  const label = document.createElement("time"); label.textContent = presentation.label;
  const body = document.createElement("div"); body.className = "event-body";
  addText(body, presentation.title, "event-title");
  for (const [detailLabel, value, className] of presentation.details || []) addCode(body, detailLabel, value, className);
  row.append(label, body);
}

function addTranscript(record) {
  const event = record?.event || record;
  const sequence = record?.sequence;
  if (sequence !== undefined) {
    if (state.transcriptSequences.has(sequence)) return;
    state.transcriptSequences.add(sequence);
  }
  byId("transcript").querySelector("[data-placeholder]")?.remove();
  const itemId = event?.item?.id;
  let row = itemId ? state.itemRows.get(itemId) : null;
  if (!row) {
    row = document.createElement("div");
    byId("transcript").append(row);
    if (itemId) state.itemRows.set(itemId, row);
  }
  renderTranscriptRow(row, event || { type: "unknown" });
  byId("transcript").scrollTop = byId("transcript").scrollHeight;
}

function replaceTranscript(records) {
  state.transcriptSequences.clear(); state.itemRows.clear(); byId("transcript").replaceChildren();
  if (!records.length) addTranscript({ type: "runner.ready", message: "Waiting for the challenge runner." });
  else records.forEach(addTranscript);
}

function showFrame(version = Date.now()) {
  if (director || state.livePreviewDevice) return;
  const image = byId("game-frame");
  image.dataset.mode = "snapshot";
  image.src = `/api/frame?v=${encodeURIComponent(version)}`;
  image.style.display = "block";
  byId("frame-placeholder").style.display = "none";
  byId("frame-time").textContent = new Date().toISOString();
}

function updateLivePreview(camera) {
  if (director) return;
  const device = camera?.active ? camera.device : null;
  if (device && state.livePreviewDevice === device) return;
  const image = byId("game-frame");
  if (!device) {
    if (!state.livePreviewDevice) return;
    state.livePreviewDevice = null;
    image.dataset.mode = "snapshot";
    showFrame("live-ended");
    return;
  }
  state.livePreviewDevice = device;
  image.dataset.mode = "live";
  image.src = `/api/live.mjpeg?device=${encodeURIComponent(device)}&t=${Date.now()}`;
  image.style.display = "block";
  byId("frame-placeholder").style.display = "none";
  byId("frame-time").textContent = "LIVE · 30 FPS";
}

async function loadOptions() {
  state.options = await fetch("/api/options").then(assertJson);
  const gameSelect = byId("game-select");
  gameSelect.replaceChildren(...state.options.games.map((game) => new Option(`${game.name} · ${game.appId}`, game.appId)));
  gameSelect.value = state.options.defaults.gameAppId;
  const modelSelect = byId("model-select");
  modelSelect.replaceChildren(...state.options.models.map((model) => new Option(model.displayName, model.slug)));
  modelSelect.value = state.options.defaults.model;
  applyConfigurationToForm(state.options.defaults);
}

function renderVirtualCameras(configuredDevice) {
  const select = byId("virtual-camera-select");
  const cameras = state.options?.virtualCameras || [];
  select.replaceChildren(...cameras.map((camera) =>
    new Option(`${camera.label} · ${camera.device}`, camera.device)
  ));
  if (!cameras.length) {
    select.append(new Option("未检测到 V4L2 loopback 设备", "/dev/video10"));
  }
  select.value = cameras.some((camera) => camera.device === configuredDevice)
    ? configuredDevice : cameras[0]?.device || "/dev/video10";
  byId("virtual-camera-toggle").disabled = !cameras.some((camera) => camera.writable);
  byId("virtual-camera-detail").textContent = cameras.length
    ? "输出正式片同款 1920×1080 / 30 fps 合成画面"
    : "需要 v4l2loopback；实体摄像头不会被用作输出设备";
  updateVirtualCameraControls();
}

function updateVirtualCameraControls() {
  const enabled = byId("virtual-camera-toggle").checked &&
    !byId("virtual-camera-toggle").disabled;
  byId("virtual-camera-select").disabled = !enabled;
}

function renderReasoningOptions() {
  const model = state.options?.models.find((entry) => entry.slug === byId("model-select").value);
  const efforts = model?.reasoningEfforts?.length ? model.reasoningEfforts : state.options?.reasoningEfforts || ["high"];
  const select = byId("reasoning-select");
  const current = select.value || state.options?.defaults.reasoningEffort;
  select.replaceChildren(...efforts.map((effort) => new Option(effort.toUpperCase(), effort)));
  select.value = efforts.includes(current) ? current : model?.defaultReasoningEffort || efforts[0];
}

function renderAccounts(policies = []) {
  const container = byId("account-pool"); container.replaceChildren();
  const configured = new Map(policies.map((policy) => [policy.accountId, policy]));
  for (const account of state.options.accounts) {
    const row = document.createElement("div"); row.className = "account-row"; row.dataset.accountId = account.id;
    const policy = configured.get(account.id);
    const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = policy?.enabled !== false; enabled.className = "account-enabled";
    const identity = document.createElement("div"); identity.className = "account-name";
    const email = document.createElement("b"); email.textContent = account.email;
    const label = document.createElement("small"); label.textContent = account.label;
    identity.append(email, label);
    row.append(
      enabled,
      identity,
      quotaInput("保留 5h", "reserveFiveHour", policy?.reserveFiveHourPercent || 0),
      quotaInput("保留 weekly", "reserveWeekly", policy?.reserveWeeklyPercent || 0),
    );
    container.append(row);
  }
  if (!state.options.accounts.length) {
    const empty = document.createElement("p"); empty.textContent = "未发现独立 Codex 账号目录；将使用默认官方凭据。"; container.append(empty);
  }
}

function applyConfigurationToForm(configured) {
  if (!configured || !state.options) return;
  const gameAppId = configured.gameAppId || configured.game?.appId || state.options.defaults.gameAppId;
  if (![...byId("game-select").options].some((option) => option.value === gameAppId)) {
    byId("game-select").append(new Option(`${configured.game?.name || "当前游戏"} · ${gameAppId}`, gameAppId));
  }
  byId("game-select").value = gameAppId;
  byId("goal-input").value = configured.goal || "";
  byId("gpu-select").value = configured.gpuPreference || "auto";
  byId("launch-mode-select").value = configured.launchMode ||
    (configured.offlineMode ? "direct" : "steam-online");
  byId("model-select").value = configured.model || state.options.defaults.model;
  renderReasoningOptions();
  byId("reasoning-select").value = configured.reasoningEffort || state.options.defaults.reasoningEffort;
  byId("record-toggle").checked = configured.record !== false;
  byId("virtual-camera-toggle").checked = configured.virtualCamera === true;
  byId("web-search-toggle").checked = configured.webSearchEnabled === true;
  byId("browser-use-toggle").checked = configured.browserUseEnabled === true;
  byId("tool-guidance-toggle").checked = configured.toolCreationGuidance === true;
  renderVirtualCameras(configured.virtualCameraDevice || state.options.defaults.virtualCameraDevice);
  renderAccounts(configured.accountPolicies || []);
  updateGameDetail();
  updateConfigurationMode();
}

function activeChallenge() {
  const phase = state.supervisor?.checkpoint?.phase || state.snapshot?.phase || "idle";
  return Boolean(state.supervisor?.active && !["completed", "failed"].includes(phase));
}

function updateConfigurationMode() {
  const active = activeChallenge();
  byId("game-select").disabled = active;
  byId("gpu-select").disabled = active;
  byId("start-button").textContent = active ? "保存并立即应用" : "从零开始挑战";
  byId("configuration-mode-note").textContent = active
    ? "挑战运行中：仅游戏和 GPU 锁定；目标与 Agent 功能开关通过同线程热重载即时生效。修改启动方式会封片并重启私有游戏运行时。"
    : "";
}

function quotaInput(label, className, value) {
  const wrapper = document.createElement("label"); wrapper.className = "quota-field";
  const text = document.createElement("span"); text.textContent = `${label} %`;
  const input = document.createElement("input"); input.type = "number"; input.min = "0"; input.max = "100"; input.step = "1"; input.value = String(value); input.className = className;
  wrapper.append(text, input); return wrapper;
}

function updateGameDetail() {
  const game = state.options?.games.find((entry) => entry.appId === byId("game-select").value);
  byId("game-detail").textContent = game ? `${game.platform} · ${game.installDirectory}` : "未选择";
}

function accountPolicies() {
  return [...byId("account-pool").querySelectorAll(".account-row")].map((row) => ({
    accountId: row.dataset.accountId,
    enabled: row.querySelector(".account-enabled").checked,
    reserveFiveHourPercent: Number(row.querySelector(".reserveFiveHour").value),
    reserveWeeklyPercent: Number(row.querySelector(".reserveWeekly").value),
  }));
}

async function submitChallenge(event) {
  event.preventDefault();
  const active = activeChallenge();
  byId("start-button").disabled = true;
  byId("form-message").textContent = active ? "正在保存…" : "正在排队…";
  try {
    const mutable = {
      launchMode: byId("launch-mode-select").value,
      model: byId("model-select").value,
      reasoningEffort: byId("reasoning-select").value,
      record: byId("record-toggle").checked,
      virtualCamera: byId("virtual-camera-toggle").checked,
      virtualCameraDevice: byId("virtual-camera-select").value,
      accountPolicies: accountPolicies(),
      goal: byId("goal-input").value,
      webSearchEnabled: byId("web-search-toggle").checked,
      browserUseEnabled: byId("browser-use-toggle").checked,
      toolCreationGuidance: byId("tool-guidance-toggle").checked,
    };
    const result = active
      ? await patchConfiguration(mutable)
      : await postControl("start", {
      gameAppId: byId("game-select").value,
      gpuPreference: byId("gpu-select").value,
      ...mutable,
    });
    const deferred = result?.acknowledgement?.deferredFields || [];
    byId("form-message").textContent = result?.pending
      ? "已提交，等待挑战进程完成应用…"
      : deferred.length
      ? `已保存；${deferred.join("、")} 将在下次游戏进程恢复时生效。`
      : active ? "配置已保存并应用。" : "";
    if (!active) byId("configuration").hidden = true;
    await refreshSupervisor();
  } catch (error) {
    byId("form-message").textContent = error.message;
  } finally { byId("start-button").disabled = false; }
}

async function patchConfiguration(body) {
  return await fetch("/api/configuration", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(assertJson);
}

async function postControl(action, body = {}) {
  return await fetch(`/api/control/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then(assertJson);
}

async function refreshSupervisor() {
  if (compact) return;
  try {
    state.supervisor = await fetch("/api/supervisor", { cache: "no-store" }).then(assertJson);
    const pool = state.supervisor.accountPool;
    const active = pool?.accounts?.find((account) => account.id === pool.activeAccountId);
    const credential = state.supervisor.currentCredential;
    const apiKeyActive = credential?.mode === "api-key";
    byId("active-account").textContent = credential?.label || active?.email || "—";
    byId("five-hour").textContent = apiKeyActive
      ? `${String(credential.provider || "custom").toUpperCase()} API KEY`
      : quotaText(active?.primary, active?.reserveFiveHourPercent);
    byId("weekly").textContent = apiKeyActive
      ? "OAUTH POOL INACTIVE"
      : quotaText(active?.secondary, active?.reserveWeeklyPercent);
    const configured = state.supervisor.checkpoint?.options || state.options?.defaults || {};
    updateCapabilityBadge(
      "web-search-badge",
      "web-search-state",
      configured.webSearchEnabled === true,
      "WEB SEARCH",
    );
    updateCapabilityBadge(
      "browser-use-badge",
      "browser-use-state",
      configured.browserUseEnabled === true,
      "BROWSER",
    );
    const checkpoint = state.supervisor.checkpoint;
    byId("next-action").textContent = checkpoint?.retryAt ? `resume ${new Date(checkpoint.retryAt).toLocaleString()}` : checkpoint?.reason || "ready";
    byId("video-parts").textContent = String(state.supervisor.recording?.parts || 0);
    byId("recording-state").textContent = state.supervisor.recording?.active ? "REC LIVE" : state.supervisor.recording?.enabled ? "REC PAUSED" : "REC OFF";
    const camera = state.supervisor.virtualCamera;
    byId("virtual-camera-state").textContent = camera?.active
      ? `LIVE ${camera.device}`
      : camera?.enabled ? `PAUSED ${camera.device}` : "OFF";
    const runnerLive = Boolean(state.supervisor.active && checkpoint?.pid);
    updateLivePreview(runnerLive
      ? { active: true, device: camera?.active ? camera.device : "private-runtime" }
      : camera);
    updateControls();
  } catch {
    byId("daemon-state").textContent = "RECONNECTING";
  }
}

function updateCapabilityBadge(badgeId, stateId, enabled, label) {
  byId(badgeId).classList.toggle("safe", !enabled);
  byId(stateId).textContent = `${label} ${enabled ? "LIVE" : "OFF"}`;
}

function quotaText(window, reserve) {
  if (!window || window.usedPercent === null) return reserve ? `unknown · reserve ${reserve}%` : "unknown";
  return `${Math.round(window.usedPercent)}% used · reserve ${reserve || 0}%`;
}

function updateControls() {
  if (compact) return;
  const phase = state.supervisor?.checkpoint?.phase || state.snapshot?.phase || "idle";
  const active = state.supervisor?.active && !["completed", "failed"].includes(phase);
  byId("pause-button").disabled = !active || phase === "paused";
  byId("resume-button").disabled = phase !== "paused";
  byId("end-button").disabled = !active;
}

async function assertJson(response) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

async function bootstrap() {
  const [snapshot, transcript] = await Promise.all([
    fetch("/api/challenge").then(assertJson),
    fetch("/api/transcript").then(assertJson),
  ]);
  applySnapshot(snapshot); replaceTranscript(transcript);
  const frameResponse = await fetch("/api/frame");
  if (frameResponse.ok && frameResponse.status !== 204) showFrame("initial");
  if (!compact) {
    if (!director) await loadOptions();
    await refreshSupervisor();
    if (!director && !state.supervisor?.active) byId("configuration").hidden = false;
    setInterval(refreshSupervisor, 2_000);
  }
}

const events = new EventSource("/api/events");
events.addEventListener("state", (event) => applySnapshot(JSON.parse(event.data)));
events.addEventListener("transcript", (event) => addTranscript(JSON.parse(event.data)));
events.addEventListener("transcript_reset", (event) => replaceTranscript(JSON.parse(event.data)));
events.addEventListener("frame", (event) => showFrame(JSON.parse(event.data).sha256));
events.addEventListener("configuration", (event) => {
  if (director) return;
  const result = JSON.parse(event.data);
  if (result.pending) return;
  byId("form-message").textContent = result.error
    ? `配置应用失败：${result.error}`
    : result.deferredFields?.length
      ? `已保存；${result.deferredFields.join("、")} 将在下次游戏进程恢复时生效。`
      : "配置已保存并应用。";
});

byId("game-frame").addEventListener("error", () => {
  const image = byId("game-frame");
  if (image.dataset.mode !== "live") return;
  state.livePreviewDevice = null;
  image.dataset.mode = "snapshot";
  byId("frame-time").textContent = "live feed reconnecting";
  showFrame("live-error");
});

if (!compact && !director) {
  byId("configure-button").addEventListener("click", () => { byId("configuration").hidden = false; });
  byId("configuration-close").addEventListener("click", () => { byId("configuration").hidden = true; });
  byId("game-select").addEventListener("change", updateGameDetail);
  byId("model-select").addEventListener("change", renderReasoningOptions);
  byId("virtual-camera-toggle").addEventListener("change", updateVirtualCameraControls);
  byId("challenge-form").addEventListener("submit", submitChallenge);
  byId("pause-button").addEventListener("click", () => postControl("pause").then(refreshSupervisor));
  byId("resume-button").addEventListener("click", () => postControl("resume").then(refreshSupervisor));
  byId("end-button").addEventListener("click", () => postControl("end").then(refreshSupervisor));
}

bootstrap().catch((error) => addTranscript({ type: "error", message: error.message }));
tick();
