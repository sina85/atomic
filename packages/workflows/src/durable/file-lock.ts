import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { processIdentity } from "./process-identity.js";

interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
  readonly acquiredAt: number;
  readonly processIdentity?: string;
}

const LOCK_OWNER_FILE = "owner.json";
const STALE_LOCK_MS = 30_000;

export function withFileLock<T>(filePath: string, fn: () => T): T {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockDir = `${filePath}.lock`;
  const deadline = Date.now() + 5000;
  let owner: LockOwner;
  while (true) {
    try {
      owner = acquireLock(lockDir);
      break;
    } catch (error) {
      if (!isExistingTargetError(error, lockDir)) throw error;
      if (tryReclaimStaleLock(lockDir)) continue;
      if (Date.now() > deadline) throw new Error(`Timed out acquiring durable workflow state lock: ${lockDir}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    releaseLock(lockDir, owner);
  }
}

function releaseLock(lockDir: string, owner: LockOwner): void {
  if (!sameLockOwner(owner, readLockOwner(lockDir))) return;
  const releasedDir = `${lockDir}.release.${owner.token}`;
  try {
    renameSync(lockDir, releasedDir);
  } catch {
    return;
  }
  if (sameLockOwner(owner, readLockOwner(releasedDir))) {
    rmSync(releasedDir, { recursive: true, force: true });
  } else {
    restoreQuarantinedLock(lockDir, releasedDir);
  }
}

function acquireLock(lockDir: string): LockOwner {
  const identity = processIdentity(process.pid);
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    acquiredAt: Date.now(),
    ...(identity !== undefined ? { processIdentity: identity } : {}),
  };
  const temporaryDir = `${lockDir}.claim.${owner.token}`;
  rmSync(temporaryDir, { recursive: true, force: true });
  mkdirSync(temporaryDir, { mode: 0o700 });
  try {
    writeFileSync(`${temporaryDir}/${LOCK_OWNER_FILE}`, JSON.stringify(owner), { encoding: "utf-8", mode: 0o600 });
    renameSync(temporaryDir, lockDir);
    return owner;
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
}

function tryReclaimStaleLock(lockDir: string): boolean {
  if (!isStaleLock(lockDir)) return false;
  // Read the owner content ONCE and decide abandonment from that snapshot. The
  // quarantine comparison must test this exact snapshot: if a contender reclaims
  // and installs a fresh live lock between here and the rename, the quarantined
  // content will differ and we must restore rather than delete a live lock.
  const snapshot = readLockOwnerRaw(lockDir);
  const owner = parseLockOwner(snapshot);
  if (owner !== undefined && !isLockOwnerAbandoned(owner)) return false;
  const quarantine = `${lockDir}.stale.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(lockDir, quarantine);
  } catch {
    return false;
  }
  if (snapshot !== readLockOwnerRaw(quarantine)) {
    restoreQuarantinedLock(lockDir, quarantine);
    return false;
  }
  rmSync(quarantine, { recursive: true, force: true });
  return true;
}

function isStaleLock(lockDir: string): boolean {
  try {
    return Date.now() - statSync(lockDir).mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}

function readLockOwnerRaw(lockDir: string): string | undefined {
  try {
    return readFileSync(`${lockDir}/${LOCK_OWNER_FILE}`, "utf-8");
  } catch {
    return undefined;
  }
}

function parseLockOwner(raw: string | undefined): LockOwner | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: object = JSON.parse(raw);
    if (!isLockOwner(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function readLockOwner(lockDir: string): LockOwner | undefined {
  return parseLockOwner(readLockOwnerRaw(lockDir));
}

function isLockOwner(value: object): value is LockOwner {
  const record = value as Partial<LockOwner>;
  return typeof record.pid === "number"
    && typeof record.host === "string"
    && typeof record.token === "string"
    && typeof record.acquiredAt === "number"
    && (record.processIdentity === undefined || typeof record.processIdentity === "string");
}

function isLockOwnerAbandoned(owner: LockOwner): boolean {
  if (owner.host !== hostname()) return true;
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
    if (owner.processIdentity === undefined) return false;
    const currentIdentity = processIdentity(owner.pid);
    return currentIdentity !== undefined && currentIdentity !== owner.processIdentity;
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
}

function sameLockOwner(a: LockOwner, b: LockOwner | undefined): boolean {
  return b !== undefined && a.pid === b.pid && a.host === b.host && a.token === b.token;
}

function restoreQuarantinedLock(lockDir: string, quarantine: string): void {
  try {
    if (!existsSync(lockDir)) renameSync(quarantine, lockDir);
  } catch {
    // Preserve quarantine rather than deleting an owner after a comparison race.
  }
}

function isExistingTargetError(error: unknown, lockDir: string): boolean {
  const code = errorCode(error);
  return code === "EEXIST" || code === "ENOTEMPTY" || (code === "EPERM" && existsSync(lockDir));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}
