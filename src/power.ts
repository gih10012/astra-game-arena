import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface PowerState {
  batteryPercent: number | null;
  discharging: boolean;
  externalPower: boolean;
}

export const LOW_BATTERY_PAUSE_PERCENT = 3;

export function shouldPauseForLowBattery(state: PowerState): boolean {
  return state.batteryPercent !== null &&
    state.batteryPercent <= LOW_BATTERY_PAUSE_PERCENT &&
    state.discharging &&
    !state.externalPower;
}

export function powerAllowsResume(state: PowerState): boolean {
  return state.externalPower ||
    state.batteryPercent === null ||
    state.batteryPercent > LOW_BATTERY_PAUSE_PERCENT;
}

export async function readPowerState(
  root = "/sys/class/power_supply",
): Promise<PowerState> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const batteries: Array<{ percent: number; status: string }> = [];
  let externalPower = false;
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const directory = path.join(root, entry.name);
    const type = await readText(path.join(directory, "type"));
    if (type === "Battery") {
      const percent = Number(await readText(path.join(directory, "capacity")));
      const status = await readText(path.join(directory, "status"));
      if (Number.isFinite(percent)) batteries.push({ percent, status });
    } else if (["Mains", "USB", "USB_C"].includes(type)) {
      externalPower ||= (await readText(path.join(directory, "online"))) === "1";
    }
  }
  return {
    batteryPercent: batteries.length
      ? Math.min(...batteries.map((battery) => battery.percent))
      : null,
    discharging: batteries.some((battery) => battery.status === "Discharging"),
    externalPower,
  };
}

async function readText(filename: string): Promise<string> {
  return (await readFile(filename, "utf8").catch(() => "")).trim();
}
