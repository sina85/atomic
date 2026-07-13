import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
let currentIdentityLoaded = false;
let currentIdentity: string | undefined;

/**
 * A locale/timezone-independent process-generation identity for a live PID,
 * used to distinguish a genuinely-live lease/lock owner from a reused PID.
 * The value must be stable across processes with different `TZ`/locale so two
 * same-host Atomic processes never disagree about the same live PID.
 */
export function processIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (pid === process.pid && currentIdentityLoaded) return currentIdentity;
  const resolved = resolveProcessIdentity(pid);
  if (pid === process.pid) {
    currentIdentityLoaded = true;
    currentIdentity = resolved;
  }
  return resolved;
}

function resolveProcessIdentity(pid: number): string | undefined {
  // Linux: field 22 of /proc/<pid>/stat is the kernel start time in clock
  // ticks — numeric and locale/timezone-independent. Prefer it when present.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const closingParen = stat.lastIndexOf(")");
    if (closingParen !== -1) {
      const fields = stat.slice(closingParen + 2).split(" ");
      const startTime = fields[19];
      if (startTime !== undefined && /^\d+$/.test(startTime)) return `starttime:${startTime}`;
    }
  } catch {
    // Not Linux, or /proc unavailable — fall back to ps/powershell below.
  }
  try {
    const result = process.platform === "win32"
      ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: "utf-8", windowsHide: true })
      // Force a fixed locale/timezone so `lstart` is identical across processes
      // with different ambient TZ/LC settings for the same live PID.
      : spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8", env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" } });
    if (result.status !== 0) return undefined;
    const identity = result.stdout.trim();
    return identity.length > 0 ? identity : undefined;
  } catch {
    return undefined;
  }
}
