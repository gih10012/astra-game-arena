// Run inside the challenge Codex process, which already receives these values.
const arenaUrl = process.env.ARENA_URL;
const controlToken = process.env.ARENA_CONTROL_TOKEN;

if (!arenaUrl || !controlToken) {
  throw new Error("ARENA_URL and ARENA_CONTROL_TOKEN are required");
}

async function post(path, body) {
  const response = await fetch(new URL(path, arenaUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${controlToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
}

for (let index = 0; index < 10; index += 1) {
  await post("/internal/pointer", {
    action: "click",
    x: 10,
    y: 10,
    button: "left",
    count: 1,
    settleMs: 0,
  });
}

await post("/internal/type", {
  text: "halloworld",
  intervalMs: 25,
  settleMs: 100,
});
