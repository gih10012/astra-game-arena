const byId = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);
const compact = query.get("compact") === "1";
const director = query.get("director") === "1";
const broadcast = location.pathname === "/live" || location.pathname === "/live/" || query.get("broadcast") === "1";
const preview = broadcast && query.get("preview") === "1";
const DRAFT_KEY = "astra-game-arena.challenge-draft.v1";
const state = {
  snapshot: null,
  supervisor: null,
  options: null,
  localReceivedAt: 0,
  transcriptSequences: new Set(),
  itemRows: new Map(),
  livePreviewDevice: null,
  broadcast: null,
  broadcastModeKey: "",
  broadcastIndex: 0,
  broadcastFormVersion: "",
  playlistDraft: [],
  draftTimer: null,
  replayFrameHandle: null,
  replayFrameMode: null,
  replayLastMediaTime: -1,
  replayLastProgressAt: 0,
  replayReconnects: 0,
  eventSourceOpens: 0,
};

if (compact) document.body.classList.add("compact");
if (director || broadcast) document.body.classList.add("director");
if (broadcast) document.body.classList.add("broadcast");
if (broadcast) document.title = "Astra Game Arena · OBS Live";
if (director || broadcast) byId("frame-time").textContent = "LIVE · 30 FPS";

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
  if (broadcast) updateResetTime();
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
  updateDraftStatus();
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
    ? "输出正式片同款画面，并同步发布仅含游戏内音频的虚拟麦克风"
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
  byId("launch-mode-select").disabled = active;
  byId("start-button").textContent = active ? "保存并立即应用" : "从零开始挑战";
  byId("configuration-mode-note").textContent = active
    ? "挑战运行中：游戏、GPU 和启动方式锁定；其余配置通过同线程热重载即时生效，游戏进程不会重启。"
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

function challengeFormValue() {
  return {
    gameAppId: byId("game-select").value,
    goal: byId("goal-input").value,
    gpuPreference: byId("gpu-select").value,
    launchMode: byId("launch-mode-select").value,
    model: byId("model-select").value,
    reasoningEffort: byId("reasoning-select").value,
    record: byId("record-toggle").checked,
    virtualCamera: byId("virtual-camera-toggle").checked,
    virtualCameraDevice: byId("virtual-camera-select").value,
    webSearchEnabled: byId("web-search-toggle").checked,
    browserUseEnabled: byId("browser-use-toggle").checked,
    toolCreationGuidance: byId("tool-guidance-toggle").checked,
    accountPolicies: accountPolicies(),
  };
}

function saveChallengeDraftSoon() {
  if (!state.options || broadcast || director || compact) return;
  clearTimeout(state.draftTimer);
  state.draftTimer = setTimeout(() => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      configuration: challengeFormValue(),
    }));
    updateDraftStatus();
  }, 250);
}

function readChallengeDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    return draft?.version === 1 && draft.configuration ? draft : null;
  } catch { return null; }
}

function updateDraftStatus() {
  const draft = readChallengeDraft();
  byId("draft-status").textContent = draft
    ? `本地草稿：${new Date(draft.savedAt).toLocaleString()}`
    : "本地草稿：无";
  byId("restore-draft-button").hidden = !draft;
  byId("clear-draft-button").hidden = !draft;
}

function clearChallengeDraft() {
  clearTimeout(state.draftTimer);
  state.draftTimer = null;
  localStorage.removeItem(DRAFT_KEY);
  updateDraftStatus();
}

async function submitChallenge(event) {
  event.preventDefault();
  const active = activeChallenge();
  byId("start-button").disabled = true;
  byId("form-message").textContent = active ? "正在保存…" : "正在排队…";
  try {
    const mutable = {
      ...(!active ? { launchMode: byId("launch-mode-select").value } : {}),
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
    clearChallengeDraft();
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

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

function renderBroadcastControl(snapshot, force = false) {
  if (broadcast || director || compact || !snapshot.library) return;
  const configuration = snapshot.configuration;
  const formOpen = !byId("broadcast-configuration").hidden;
  if (!force && formOpen && state.broadcastFormVersion === configuration.updatedAt) return;
  state.broadcastFormVersion = configuration.updatedAt;
  state.playlistDraft = [...configuration.playlist];
  byId("broadcast-mode").value = configuration.mode;
  byId("replay-idle").checked = configuration.replayWhenIdle;
  byId("replay-quota").checked = configuration.replayWhenQuota;
  byId("replay-paused").checked = configuration.replayWhenPaused;
  byId("replay-power").checked = configuration.replayWhenPower;
  byId("replay-retry").checked = configuration.replayWhenRetry;
  byId("replay-loop").checked = configuration.loop;
  byId("replay-badge").checked = configuration.showReplayBadge;
  byId("replay-reset-time").checked = configuration.showResetTime;
  byId("broadcast-audio").checked = configuration.audioEnabled;
  byId("replay-badge-text").value = configuration.replayBadgeText;
  byId("broadcast-volume").value = String(configuration.volume);
  byId("broadcast-volume-label").textContent = `${Math.round(configuration.volume * 100)}%`;
  byId("live-url").value = snapshot.liveUrl;
  byId("broadcast-playback-state").textContent =
    `${snapshot.playback.mode.toUpperCase()} · ${snapshot.playback.reason}`;
  renderMediaLibrary(snapshot.library);
}

function renderMediaLibrary(library = state.broadcast?.library || []) {
  const container = byId("media-library");
  container.replaceChildren();
  const byMediaId = new Map(library.map((item) => [item.id, item]));
  state.playlistDraft = state.playlistDraft.filter((id) => byMediaId.has(id));
  const selected = state.playlistDraft.flatMap((id) => byMediaId.get(id) ? [byMediaId.get(id)] : []);
  const selectedIds = new Set(state.playlistDraft);
  const items = [...selected, ...library.filter((item) => !selectedIds.has(item.id))];
  if (!items.length) {
    const empty = document.createElement("p");
    empty.textContent = "尚未发现录像。可将文件放入 .arena/broadcast-media，或在上方添加绝对路径。";
    container.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    const index = state.playlistDraft.indexOf(item.id);
    row.className = `media-row${index >= 0 ? " selected" : ""}`;
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = index >= 0;
    enabled.setAttribute("aria-label", `选择 ${item.name}`);
    enabled.addEventListener("change", () => {
      state.playlistDraft = enabled.checked
        ? [...state.playlistDraft, item.id]
        : state.playlistDraft.filter((id) => id !== item.id);
      renderMediaLibrary(library);
    });
    const identity = document.createElement("div"); identity.className = "media-name";
    const name = document.createElement("b"); name.textContent = item.name;
    const location = document.createElement("small"); location.textContent = item.displayPath;
    identity.append(name, location);
    const meta = document.createElement("span"); meta.className = "media-meta";
    meta.textContent = `${item.source.toUpperCase()} · ${formatBytes(item.bytes)}`;
    const up = document.createElement("button"); up.type = "button"; up.textContent = "↑";
    up.disabled = index <= 0;
    up.addEventListener("click", () => {
      [state.playlistDraft[index - 1], state.playlistDraft[index]] =
        [state.playlistDraft[index], state.playlistDraft[index - 1]];
      renderMediaLibrary(library);
    });
    const down = document.createElement("button"); down.type = "button"; down.textContent = "↓";
    down.disabled = index < 0 || index >= state.playlistDraft.length - 1;
    down.addEventListener("click", () => {
      [state.playlistDraft[index], state.playlistDraft[index + 1]] =
        [state.playlistDraft[index + 1], state.playlistDraft[index]];
      renderMediaLibrary(library);
    });
    const forget = document.createElement(item.source === "manual" ? "button" : "span");
    if (item.source === "manual") {
      forget.type = "button"; forget.textContent = "忘记路径";
      forget.addEventListener("click", async () => {
        try {
          const snapshot = await fetch(`/api/broadcast/media?id=${encodeURIComponent(item.id)}`, {
            method: "DELETE",
          }).then(assertJson);
          applyBroadcastSnapshot(snapshot);
          renderBroadcastControl(snapshot, true);
          byId("broadcast-message").textContent = "已忘记路径；原视频文件未删除。";
        } catch (error) { byId("broadcast-message").textContent = error.message; }
      });
    }
    row.append(enabled, identity, meta, up, down, forget);
    container.append(row);
  }
}

async function refreshBroadcast() {
  try {
    const snapshot = await fetch("/api/broadcast", { cache: "no-store" }).then(assertJson);
    applyBroadcastSnapshot(snapshot);
  } catch (error) {
    if (broadcast) showBroadcastNote(`播出控制重连中：${error.message}`);
  }
}

function applyBroadcastSnapshot(snapshot) {
  state.broadcast = snapshot;
  renderBroadcastControl(snapshot);
  if (!broadcast) return;
  const configuration = snapshot.configuration;
  const playback = snapshot.playback;
  byId("replay-badge-label").textContent = configuration.replayBadgeText;
  byId("replay-badge-overlay").hidden = !configuration.showReplayBadge;
  const showReset = configuration.showResetTime && playback.reason === "waiting_quota" && playback.retryAt;
  byId("quota-reset-overlay").hidden = !showReset;
  updateResetTime();
  const modeKey = `${playback.mode}:${snapshot.selected.map((item) => item.id).join(",")}`;
  applyBroadcastVolume();
  if (modeKey === state.broadcastModeKey) return;
  state.broadcastModeKey = modeKey;
  showBroadcastNote("");
  if (playback.mode === "replay") startReplay(0);
  else if (playback.mode === "live") startLiveBroadcast();
  else stopBroadcastMedia();
}

function applyBroadcastVolume() {
  if (!broadcast || !state.broadcast) return;
  const configuration = state.broadcast.configuration;
  const muted = preview || !configuration.audioEnabled;
  for (const media of [byId("replay-video"), byId("live-audio")]) {
    media.muted = muted;
    media.volume = configuration.volume;
  }
}

function stopBroadcastMedia() {
  stopReplayCanvas();
  byId("broadcast-replay").hidden = true;
  const video = byId("replay-video");
  video.pause(); video.removeAttribute("src"); video.load();
  const audio = byId("live-audio");
  audio.pause(); audio.removeAttribute("src"); audio.load();
  updateLivePreview(null);
}

function startLiveBroadcast() {
  stopReplayCanvas();
  byId("broadcast-replay").hidden = true;
  const video = byId("replay-video");
  video.pause(); video.removeAttribute("src"); video.load();
  updateLivePreview({ active: true, device: "private-runtime" });
  const audio = byId("live-audio");
  audio.src = `/api/live-audio.ogg?t=${Date.now()}`;
  applyBroadcastVolume();
  if (state.broadcast.configuration.audioEnabled && !preview) {
    audio.play().catch(() => showBroadcastNote("浏览器阻止了自动播放声音；OBS Browser Source 不受此交互限制"));
  }
}

function startReplay(index) {
  const selected = state.broadcast?.selected || [];
  if (!selected.length) { stopBroadcastMedia(); return; }
  state.broadcastIndex = Math.min(Math.max(0, index), selected.length - 1);
  state.replayReconnects = 0;
  loadReplayItem();
}

function loadReplayItem() {
  const selected = state.broadcast?.selected || [];
  const item = selected[state.broadcastIndex];
  if (!item) { stopBroadcastMedia(); return; }
  const audio = byId("live-audio");
  audio.pause(); audio.removeAttribute("src"); audio.load();
  updateLivePreview(null);
  byId("broadcast-replay").hidden = false;
  byId("replay-clip-name").textContent = item.name;
  const video = byId("replay-video");
  stopReplayCanvas();
  const canvas = byId("replay-canvas");
  canvas.getContext("2d").fillRect(0, 0, canvas.width, canvas.height);
  video.src = `/api/broadcast/replay?id=${encodeURIComponent(item.id)}&t=${Date.now()}`;
  state.replayLastMediaTime = -1;
  state.replayLastProgressAt = performance.now();
  applyBroadcastVolume();
  video.play().catch(() => showBroadcastNote("回放等待自动播放；请检查 OBS Browser Source 的页面权限"));
}

function startReplayCanvas() {
  if (state.replayFrameHandle !== null) return;
  const video = byId("replay-video");
  const canvas = byId("replay-canvas");
  const context = canvas.getContext("2d", { alpha: false });
  const paint = () => {
    if (state.broadcast?.playback?.mode !== "replay" || video.paused || video.ended) {
      state.replayFrameHandle = null;
      state.replayFrameMode = null;
      return;
    }
    if (video.readyState >= 2 && video.videoWidth > 0) {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
    }
    if (typeof video.requestVideoFrameCallback === "function") {
      state.replayFrameMode = "video";
      state.replayFrameHandle = video.requestVideoFrameCallback(paint);
    } else {
      state.replayFrameMode = "animation";
      state.replayFrameHandle = requestAnimationFrame(paint);
    }
  };
  paint();
}

function stopReplayCanvas() {
  const video = byId("replay-video");
  if (state.replayFrameHandle !== null) {
    if (state.replayFrameMode === "video" && typeof video.cancelVideoFrameCallback === "function") {
      video.cancelVideoFrameCallback(state.replayFrameHandle);
    } else if (state.replayFrameMode === "animation") {
      cancelAnimationFrame(state.replayFrameHandle);
    }
  }
  state.replayFrameHandle = null;
  state.replayFrameMode = null;
}

function watchBroadcastMedia() {
  if (!broadcast || state.broadcast?.playback?.mode !== "replay") return;
  const video = byId("replay-video");
  if (!video.paused && video.currentTime > state.replayLastMediaTime + 0.05) {
    state.replayLastMediaTime = video.currentTime;
    state.replayLastProgressAt = performance.now();
    return;
  }
  if (performance.now() - state.replayLastProgressAt < 8_000) return;
  state.replayReconnects += 1;
  showBroadcastNote(`回放流停滞，正在重连（${state.replayReconnects}）`);
  loadReplayItem();
}

function advanceReplay() {
  const selected = state.broadcast?.selected || [];
  if (state.broadcastIndex + 1 < selected.length) startReplay(state.broadcastIndex + 1);
  else if (state.broadcast?.configuration.loop && selected.length) startReplay(0);
}

function showBroadcastNote(message) {
  const note = byId("broadcast-stream-note");
  note.textContent = message;
  note.hidden = !message;
}

function updateResetTime() {
  const retryAt = state.broadcast?.playback?.retryAt;
  if (!retryAt) return;
  const remaining = Math.max(0, Date.parse(retryAt) - Date.now());
  const totalSeconds = Math.ceil(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  byId("quota-reset-time").textContent =
    `${new Date(retryAt).toLocaleString()} · ${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

async function saveBroadcast(event) {
  event.preventDefault();
  byId("broadcast-save").disabled = true;
  byId("broadcast-message").textContent = "正在保存并切换…";
  try {
    const snapshot = await fetch("/api/broadcast", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: byId("broadcast-mode").value,
        playlist: state.playlistDraft,
        replayWhenIdle: byId("replay-idle").checked,
        replayWhenQuota: byId("replay-quota").checked,
        replayWhenPaused: byId("replay-paused").checked,
        replayWhenPower: byId("replay-power").checked,
        replayWhenRetry: byId("replay-retry").checked,
        loop: byId("replay-loop").checked,
        showReplayBadge: byId("replay-badge").checked,
        showResetTime: byId("replay-reset-time").checked,
        audioEnabled: byId("broadcast-audio").checked,
        replayBadgeText: byId("replay-badge-text").value,
        volume: Number(byId("broadcast-volume").value),
      }),
    }).then(assertJson);
    applyBroadcastSnapshot(snapshot);
    renderBroadcastControl(snapshot, true);
    byId("broadcast-message").textContent = "已持久化并立即应用到 /live。";
  } catch (error) {
    byId("broadcast-message").textContent = error.message;
  } finally { byId("broadcast-save").disabled = false; }
}

async function importBroadcastMedia() {
  const path = byId("media-path").value.trim();
  if (!path) return;
  byId("media-import-button").disabled = true;
  try {
    const snapshot = await fetch("/api/broadcast/media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, select: true }),
    }).then(assertJson);
    byId("media-path").value = "";
    applyBroadcastSnapshot(snapshot);
    renderBroadcastControl(snapshot, true);
    byId("broadcast-message").textContent = "视频已加入播放列表。";
  } catch (error) {
    byId("broadcast-message").textContent = error.message;
  } finally { byId("media-import-button").disabled = false; }
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
    const microphone = state.supervisor.virtualMicrophone;
    byId("virtual-microphone-state").textContent = microphone?.active
      ? `LIVE ${microphone.label || microphone.name}`
      : microphone?.enabled ? `PAUSED ${microphone.label || "Astra Game Microphone"}` : "OFF";
    if (!broadcast) {
      const runnerLive = Boolean(state.supervisor.active && checkpoint?.pid);
      updateLivePreview(runnerLive
        ? { active: true, device: camera?.active ? camera.device : "private-runtime" }
        : camera);
    }
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
  if (compact || director || broadcast) return;
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
    if (!director && !broadcast) await loadOptions();
    await refreshSupervisor();
    await refreshBroadcast();
    if (!director && !broadcast && !state.supervisor?.active) byId("configuration").hidden = false;
    setInterval(refreshSupervisor, 2_000);
    setInterval(refreshBroadcast, 2_000);
  }
}

const events = new EventSource("/api/events");
events.addEventListener("open", () => {
  state.eventSourceOpens += 1;
  if (!broadcast || state.eventSourceOpens === 1) return;
  state.broadcastModeKey = "";
  void refreshBroadcast();
});
events.addEventListener("state", (event) => applySnapshot(JSON.parse(event.data)));
events.addEventListener("transcript", (event) => addTranscript(JSON.parse(event.data)));
events.addEventListener("transcript_reset", (event) => replaceTranscript(JSON.parse(event.data)));
events.addEventListener("frame", (event) => showFrame(JSON.parse(event.data).sha256));
events.addEventListener("broadcast", (event) => applyBroadcastSnapshot(JSON.parse(event.data)));
events.addEventListener("configuration", (event) => {
  if (director || broadcast) return;
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

byId("replay-video").addEventListener("ended", advanceReplay);
byId("replay-video").addEventListener("playing", () => {
  state.replayLastProgressAt = performance.now();
  startReplayCanvas();
  showBroadcastNote("");
});
byId("replay-video").addEventListener("error", () => {
  if (!broadcast || state.broadcast?.playback?.mode !== "replay") return;
  showBroadcastNote("回放文件无法解码，正在尝试播放列表下一项");
  setTimeout(advanceReplay, 1_500);
});
byId("live-audio").addEventListener("playing", () => showBroadcastNote(""));
document.addEventListener("click", () => {
  if (!broadcast || preview || !state.broadcast?.configuration?.audioEnabled) return;
  const media = state.broadcast.playback.mode === "live" ? byId("live-audio") : byId("replay-video");
  media.play().catch(() => undefined);
}, { passive: true });
document.addEventListener("visibilitychange", () => {
  if (!broadcast || document.hidden || state.broadcast?.playback?.mode !== "replay") return;
  byId("replay-video").play().then(startReplayCanvas).catch(() => undefined);
});

if (!compact && !director && !broadcast) {
  byId("configure-button").addEventListener("click", () => { byId("configuration").hidden = false; });
  byId("configuration-close").addEventListener("click", () => { byId("configuration").hidden = true; });
  byId("broadcast-button").addEventListener("click", async () => {
    byId("broadcast-configuration").hidden = false;
    byId("live-preview").src = "/live?preview=1";
    await refreshBroadcast();
  });
  byId("broadcast-close").addEventListener("click", () => { byId("broadcast-configuration").hidden = true; });
  byId("open-live-button").addEventListener("click", () => window.open("/live", "_blank", "noopener"));
  byId("preview-live").addEventListener("click", () => window.open("/live?preview=1", "_blank", "noopener"));
  byId("copy-live-url").addEventListener("click", async () => {
    await navigator.clipboard.writeText(byId("live-url").value);
    byId("broadcast-message").textContent = "OBS Live 地址已复制。";
  });
  byId("broadcast-form").addEventListener("submit", saveBroadcast);
  byId("media-import-button").addEventListener("click", importBroadcastMedia);
  byId("broadcast-volume").addEventListener("input", () => {
    byId("broadcast-volume-label").textContent = `${Math.round(Number(byId("broadcast-volume").value) * 100)}%`;
  });
  byId("challenge-form").addEventListener("input", saveChallengeDraftSoon);
  byId("challenge-form").addEventListener("change", saveChallengeDraftSoon);
  byId("restore-draft-button").addEventListener("click", () => {
    const draft = readChallengeDraft();
    if (draft) applyConfigurationToForm(draft.configuration);
  });
  byId("clear-draft-button").addEventListener("click", clearChallengeDraft);
  byId("game-select").addEventListener("change", updateGameDetail);
  byId("model-select").addEventListener("change", renderReasoningOptions);
  byId("virtual-camera-toggle").addEventListener("change", updateVirtualCameraControls);
  byId("challenge-form").addEventListener("submit", submitChallenge);
  byId("pause-button").addEventListener("click", () => postControl("pause").then(refreshSupervisor));
  byId("resume-button").addEventListener("click", () => postControl("resume").then(refreshSupervisor));
  byId("end-button").addEventListener("click", () => postControl("end").then(refreshSupervisor));
}

bootstrap().catch((error) => addTranscript({ type: "error", message: error.message }));
setInterval(watchBroadcastMedia, 2_000);
tick();
