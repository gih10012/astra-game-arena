import { runCommand } from "./command.js";

export interface PrivateGameAudio {
  sinkName: string;
  microphoneName: string;
  microphoneLabel: string;
  microphoneActive(): boolean;
  microphoneHealthy(): Promise<boolean>;
  enableMicrophone(): Promise<void>;
  disableMicrophone(): Promise<void>;
  close(): Promise<void>;
}

interface PulseModule {
  id: string;
  name: string;
}

export function privateAudioNodeNames(runId: string): {
  sink: string;
  microphone: string;
  fallback: string;
} {
  const suffix = runId.toLowerCase().replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(-48);
  if (!suffix) throw new Error("Run id cannot be converted to an audio node name");
  return {
    sink: `astra_game_audio_${suffix}`,
    microphone: `astra_game_microphone_${suffix}`,
    fallback: `astra_desktop_fallback_${suffix}`,
  };
}

export async function startPrivateGameAudio(runId: string): Promise<PrivateGameAudio> {
  const names = privateAudioNodeNames(runId);
  await cleanupPrivateGameAudio(runId);
  const originalDefault = await pulseText(["get-default-sink"]);
  const modules: PulseModule[] = [];
  let microphone: PulseModule | null = null;
  let closed = false;

  const load = async (name: string, args: string[]): Promise<PulseModule> => {
    const id = await pulseText(["load-module", name, ...args]);
    if (!/^\d+$/.test(id)) throw new Error(`pactl returned an invalid module id: ${id}`);
    const module = { id, name };
    modules.push(module);
    return module;
  };

  try {
    let restoredDefault = originalDefault;
    if (originalDefault === "auto_null") {
      await load("module-null-sink", [
        `sink_name=${names.fallback}`,
        "sink_properties=device.description=\"Astra Desktop Fallback\" device.class=\"abstract\"",
        "format=s16le",
        "rate=48000",
        "channels=2",
        "channel_map=front-left,front-right",
      ]);
      restoredDefault = names.fallback;
      await pulseText(["set-default-sink", restoredDefault]);
    }

    await load("module-null-sink", [
      `sink_name=${names.sink}`,
      "sink_properties=device.description=\"Astra Private Game Audio\" device.class=\"abstract\"",
      "format=s16le",
      "rate=48000",
      "channels=2",
      "channel_map=front-left,front-right",
    ]);
    if (restoredDefault && await pulseSinkExists(restoredDefault)) {
      await pulseText(["set-default-sink", restoredDefault]);
    }

    const disableMicrophone = async () => {
      const active = microphone;
      microphone = null;
      if (!active) return;
      await unloadPulseModule(active);
      const index = modules.indexOf(active);
      if (index >= 0) modules.splice(index, 1);
    };

    return {
      sinkName: names.sink,
      microphoneName: names.microphone,
      microphoneLabel: "Astra Game Microphone",
      microphoneActive: () => microphone !== null,
      microphoneHealthy: async () =>
        microphone !== null && await pulseSourceExists(names.microphone),
      enableMicrophone: async () => {
        if (closed) throw new Error("Private game audio is closed");
        if (microphone && await pulseSourceExists(names.microphone)) return;
        if (microphone) {
          const stale = microphone;
          microphone = null;
          const index = modules.indexOf(stale);
          if (index >= 0) modules.splice(index, 1);
        }
        microphone = await load("module-remap-source", [
          `master=${names.sink}.monitor`,
          `source_name=${names.microphone}`,
          "source_properties=device.description=\"Astra Game Microphone\" device.class=\"sound\"",
          "channels=2",
          "master_channel_map=front-left,front-right",
          "channel_map=front-left,front-right",
          "remix=no",
        ]);
      },
      disableMicrophone,
      close: async () => {
        if (closed) return;
        closed = true;
        await disableMicrophone().catch(() => undefined);
        for (const module of [...modules].reverse()) {
          await unloadPulseModule(module).catch(() => undefined);
        }
        if (originalDefault && await pulseSinkExists(originalDefault)) {
          await pulseText(["set-default-sink", originalDefault]).catch(() => undefined);
        }
      },
    };
  } catch (error) {
    for (const module of [...modules].reverse()) {
      await unloadPulseModule(module).catch(() => undefined);
    }
    throw error;
  }
}

export async function cleanupPrivateGameAudio(runId: string): Promise<void> {
  const names = privateAudioNodeNames(runId);
  const moduleList = await runCommand("pactl", ["list", "short", "modules"], {
    timeoutMs: 5_000,
  }).catch(() => null);
  if (!moduleList || moduleList.code !== 0) return;
  const markers = [names.microphone, names.sink, names.fallback];
  const moduleIds = moduleList.stdout.toString("utf8").split(/\r?\n/)
    .filter((line) => markers.some((marker) => line.includes(marker)))
    .flatMap((line) => /^\s*(\d+)\b/.exec(line)?.[1] ?? []);

  const defaultSink = await pulseText(["get-default-sink"]).catch(() => "");
  if (defaultSink === names.fallback) {
    const sinks = await runCommand("pactl", ["list", "short", "sinks"], {
      timeoutMs: 5_000,
    }).catch(() => null);
    const replacement = sinks?.stdout.toString("utf8").split(/\r?\n/)
      .map((line) => line.split("\t")[1] ?? "")
      .find((name) => name && !/^astra_(?:game_audio|desktop_fallback)_/.test(name));
    if (replacement) await pulseText(["set-default-sink", replacement]).catch(() => undefined);
  }
  for (const id of [...new Set(moduleIds)].reverse()) {
    await unloadPulseModule({ id, name: "stale Astra game audio" }).catch(() => undefined);
  }
}

async function pulseText(args: string[]): Promise<string> {
  const result = await runCommand("pactl", args, { timeoutMs: 5_000 });
  if (result.code !== 0) {
    throw new Error(
      result.stderr.toString("utf8").trim() || `pactl ${args[0]} failed`,
    );
  }
  return result.stdout.toString("utf8").trim();
}

async function pulseSinkExists(name: string): Promise<boolean> {
  const result = await runCommand("pactl", ["list", "short", "sinks"], {
    timeoutMs: 5_000,
  });
  if (result.code !== 0) return false;
  return result.stdout.toString("utf8").split(/\r?\n/).some((line) =>
    line.split("\t")[1] === name
  );
}

async function pulseSourceExists(name: string): Promise<boolean> {
  const result = await runCommand("pactl", ["list", "short", "sources"], {
    timeoutMs: 5_000,
  });
  if (result.code !== 0) return false;
  return result.stdout.toString("utf8").split(/\r?\n/).some((line) =>
    line.split("\t")[1] === name
  );
}

async function unloadPulseModule(module: PulseModule): Promise<void> {
  const result = await runCommand("pactl", ["unload-module", module.id], {
    timeoutMs: 5_000,
  });
  if (result.code !== 0 && !/no such entity|not found/i.test(
    result.stderr.toString("utf8"),
  )) {
    throw new Error(`Could not unload PulseAudio module ${module.name}`);
  }
}
