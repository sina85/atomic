import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { withFileLock } from "./file-lock.js";
import { processIdentity } from "./process-identity.js";

interface ExecutionLeaseOwner {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
  readonly acquiredAt: number;
  readonly processIdentity?: string;
}

const OWNER_FILE = "owner.json";
const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_HEARTBEAT_MS = 30_000;
const heartbeats = new Map<string, ReturnType<typeof setInterval>>();

export function executionLeasePath(filePath: string): string {
  return `${filePath}.active`;
}

/** Test-only: number of live heartbeat intervals (must return to 0 after release/prune). */
export function activeHeartbeatCountForTests(): number {
  return heartbeats.size;
}

export function claimExecutionLease(filePath: string, token: string): boolean {
  return withFileLock(filePath, () => {
    const leasePath = executionLeasePath(filePath);
    if (existsSync(leasePath)) {
      const owner = readOwner(leasePath);
      if (owner?.token === token) return false;
      if (leaseIsActive(leasePath, owner)) return false;
      rmSync(leasePath, { recursive: true, force: true });
    }
    const temporaryPath = `${leasePath}.claim-${token}`;
    rmSync(temporaryPath, { recursive: true, force: true });
    mkdirSync(temporaryPath, { mode: 0o700 });
    try {
      const identity = processIdentity(process.pid);
      const owner: ExecutionLeaseOwner = {
        pid: process.pid,
        host: hostname(),
        token,
        acquiredAt: Date.now(),
        ...(identity !== undefined ? { processIdentity: identity } : {}),
      };
      writeFileSync(`${temporaryPath}/${OWNER_FILE}`, JSON.stringify(owner), { encoding: "utf-8", mode: 0o600 });
      renameSync(temporaryPath, leasePath);
    } finally {
      rmSync(temporaryPath, { recursive: true, force: true });
    }
    startHeartbeat(leasePath, token);
    return true;
  });
}

export function hasActiveExecutionLease(filePath: string): boolean {
  return withFileLock(filePath, () => {
    const leasePath = executionLeasePath(filePath);
    if (!existsSync(leasePath)) return false;
    const owner = readOwner(leasePath);
    if (leaseIsActive(leasePath, owner)) return true;
    if (owner !== undefined) stopHeartbeat(leasePath, owner.token);
    rmSync(leasePath, { recursive: true, force: true });
    return false;
  });
}

export function releaseExecutionLease(filePath: string, token: string): void {
  const leasePath = executionLeasePath(filePath);
  // Always stop OUR heartbeat for this token first — even if the lease
  // directory was already pruned out-of-band (a completed/cancelled workflow
  // removes it). Heartbeats are keyed by lease path + token, so this never
  // affects another owner's heartbeat, and it prevents a leaked interval that
  // would keep issuing failed writes for the life of the process.
  stopHeartbeat(leasePath, token);
  withFileLock(filePath, () => {
    if (readOwner(leasePath)?.token === token) rmSync(leasePath, { recursive: true, force: true });
  });
}

function leaseIsActive(leasePath: string, owner: ExecutionLeaseOwner | undefined): boolean {
  if (owner === undefined) return heartbeatAge(leasePath) <= STALE_HEARTBEAT_MS && existsSync(`${leasePath}/${OWNER_FILE}`);
  // A foreign-host lease cannot be safely liveness-checked from here: heartbeat
  // age is the owner's event-loop clock, so a long synchronous stage or a
  // shared-filesystem delay could let another host reclaim a still-live lease
  // and double-dispatch. File durability is a same-host store; cross-host
  // coordination must use the DBOS/PostgreSQL backend (connection-fenced
  // advisory locks). So a foreign-host lease is conservatively active; clear a
  // genuinely abandoned one with `/workflow kill` or use DBOS.
  if (owner.host !== hostname()) return true;
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return true;
  try {
    process.kill(owner.pid, 0);
    // PID is alive. Confirm it is the SAME process via process-generation
    // identity when both saved and current identities are available. On Linux
    // this is the kernel start time in clock ticks, which distinguishes a PID
    // reused even within the same second.
    if (owner.processIdentity !== undefined) {
      const currentIdentity = processIdentity(owner.pid);
      if (currentIdentity !== undefined) return currentIdentity === owner.processIdentity;
    }
    // The PID is confirmed alive but identity cannot be verified (unsaved, or
    // the lookup is unavailable/blocked — e.g. `ps`/`powershell.exe` missing).
    // Do NOT evict a confirmed-live PID on heartbeat age alone: a long
    // synchronous stage can stall the heartbeat while the owner is still running,
    // and reclaiming it would double-dispatch. A genuinely reused PID in this
    // rare case must be cleared explicitly with `/workflow kill`.
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function heartbeatAge(leasePath: string): number {
  try {
    return Date.now() - statSync(`${leasePath}/${OWNER_FILE}`).mtimeMs;
  } catch {
    try {
      return Date.now() - statSync(leasePath).mtimeMs;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }
}

function heartbeatKey(leasePath: string, token: string): string {
  return `${leasePath}\0${token}`;
}

function startHeartbeat(leasePath: string, token: string): void {
  const key = heartbeatKey(leasePath, token);
  if (heartbeats.has(key)) return;
  const timer = setInterval(() => {
    // Stop when the lease directory is definitively gone (released, pruned, or
    // reclaimed) so a completed workflow never leaks a heartbeat interval that
    // keeps issuing failed writes for the life of the process. A transient
    // owner.json read failure while the directory still exists is retried.
    if (!existsSync(leasePath)) {
      stopHeartbeat(leasePath, token);
      return;
    }
    const owner = readOwner(leasePath);
    if (owner !== undefined && owner.token !== token) {
      stopHeartbeat(leasePath, token);
      return;
    }
    try {
      const now = new Date();
      utimesSync(`${leasePath}/${OWNER_FILE}`, now, now);
    } catch {
      // Transient; retry next tick.
    }
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  heartbeats.set(key, timer);
}

function stopHeartbeat(leasePath: string, token: string): void {
  const key = heartbeatKey(leasePath, token);
  const timer = heartbeats.get(key);
  if (timer !== undefined) clearInterval(timer);
  heartbeats.delete(key);
}

function readOwner(leasePath: string): ExecutionLeaseOwner | undefined {
  try {
    const parsed: object = JSON.parse(readFileSync(`${leasePath}/${OWNER_FILE}`, "utf-8"));
    if (!isOwner(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function isOwner(value: object): value is ExecutionLeaseOwner {
  const owner = value as Partial<ExecutionLeaseOwner>;
  return typeof owner.pid === "number"
    && typeof owner.host === "string"
    && typeof owner.token === "string"
    && typeof owner.acquiredAt === "number"
    && (owner.processIdentity === undefined || typeof owner.processIdentity === "string");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}
