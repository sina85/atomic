import { spawnSync } from "node:child_process";
let currentIdentityLoaded = false;
let currentIdentity: string | undefined;

export function processIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (pid === process.pid && currentIdentityLoaded) return currentIdentity;
  try {
    const result = process.platform === "win32"
      ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: "utf-8", windowsHide: true })
      : spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8" });
    if (result.status !== 0) return undefined;
    const identity = result.stdout.trim();
    const resolved = identity.length > 0 ? identity : undefined;
    if (pid === process.pid) {
      currentIdentityLoaded = true;
      currentIdentity = resolved;
    }
    return resolved;
  } catch {
    return undefined;
  }
}
