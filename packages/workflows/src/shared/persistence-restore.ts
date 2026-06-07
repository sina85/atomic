/**
 * Restore: scan session entries for in-flight runs on session_start.
 * Detects run.start entries without matching run.end and marks crashed or
 * attempts resume per the `resumeInFlight` config option.
 *
 * cross-ref: spec §5.6, §5.13
 */

import type { RunEndMetadata, Store } from "./store.js";
import type { RunSnapshot, StageSnapshot, StageStatus, WorkflowChildReplaySnapshot, WorkflowFailureDisposition, WorkflowFailureKind, WorkflowFailureRecoverability } from "./store-types.js";
import type { WorkflowInputValues, WorkflowOutputValues } from "./types.js";
import { workflowSerializableObjectSchema } from "./serializable.js";
import { Value } from "typebox/value";
import { isWorkflowFailureKind } from "./workflow-failures.js";

// ---------------------------------------------------------------------------
// Config option
// ---------------------------------------------------------------------------

/** Controls what the extension does with in-flight runs on session_start. */
export type ResumeInFlight = "ask" | "auto" | "never";

// ---------------------------------------------------------------------------
// Session entry types
// ---------------------------------------------------------------------------

/** Minimal shape of a pi session entry as returned by sessionManager.getEntries(). */
export interface SessionEntry {
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

/** Structural type for pi's sessionManager (optional — degrades gracefully). */
export interface SessionManager {
  getEntries?: () => SessionEntry[] | readonly SessionEntry[];
}

// ---------------------------------------------------------------------------
// In-flight run descriptor (result of scan)
// ---------------------------------------------------------------------------

export interface InFlightRun {
  readonly runId: string;
  readonly name: string;
  readonly inputs: Readonly<WorkflowInputValues>;
  readonly startTs: number;
  /** Stage IDs that were started (in order) but may or may not have ended. */
  readonly stageIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Scan logic
// ---------------------------------------------------------------------------

/**
 * Scans a list of session entries and returns runs that have a
 * `workflow.run.start` entry but no matching `workflow.run.end`.
 *
 * Pure function — does not mutate anything.
 */
export function scanInFlightRuns(entries: readonly SessionEntry[]): InFlightRun[] {
  const started = new Map<string, { name: string; inputs: WorkflowInputValues; startTs: number; stageIds: string[] }>();
  const ended = new Set<string>();
  const blocked = new Set<string>();

  for (const entry of entries) {
    if (entry.type === "workflow.run.start") {
      const runId = entry.payload["runId"];
      const name = entry.payload["name"];
      const inputs = entry.payload["inputs"];
      const ts = entry.payload["ts"];
      if (
        typeof runId === "string" &&
        typeof name === "string" &&
        typeof ts === "number"
      ) {
        started.set(runId, {
          name,
          inputs: serializableObjectOrEmpty(inputs),
          startTs: ts,
          stageIds: [],
        });
      }
    }

    if (entry.type === "workflow.stage.start") {
      const runId = entry.payload["runId"];
      const stageId = entry.payload["stageId"];
      if (typeof runId === "string" && typeof stageId === "string") {
        const run = started.get(runId);
        if (run && !run.stageIds.includes(stageId)) {
          run.stageIds.push(stageId);
        }
      }
    }

    if (entry.type === "workflow.run.end") {
      const runId = entry.payload["runId"];
      if (typeof runId === "string") {
        ended.add(runId);
      }
    }

    if (entry.type === "workflow.run.blocked") {
      const runId = entry.payload["runId"];
      if (typeof runId === "string") {
        blocked.add(runId);
      }
    }
  }

  const result: InFlightRun[] = [];
  for (const [runId, info] of started) {
    if (!ended.has(runId) && !blocked.has(runId)) {
      result.push({
        runId,
        name: info.name,
        inputs: Object.freeze({ ...info.inputs }),
        startTs: info.startTs,
        stageIds: Object.freeze([...info.stageIds]),
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Restore callbacks
// ---------------------------------------------------------------------------

export interface RestoreCallbacks {
  /**
   * Called when a run is detected as crashed (no end entry, session restarted).
   * Implementations typically mark the run "failed" in the store and optionally
   * notify the user.
   */
  onCrashed?: (run: InFlightRun) => void;
  /**
   * Called when a run is being resumed (resumeInFlight === "auto").
   * Implementations typically re-register the run in the store with status "running".
   */
  onResume?: (run: InFlightRun) => void;
}

// ---------------------------------------------------------------------------
// restoreOnSessionStart
// ---------------------------------------------------------------------------

/**
 * Entry point called on `session_start`.
 *
 * Behavior by `config.resumeInFlight`:
 *   "never" — mark all in-flight runs as crashed (failed) in the store.
 *   "auto"  — restore in-flight runs to "running" in the store and call onResume.
 *   "ask"   — same as "never" for store side-effects; onCrashed is called so
 *             the caller can prompt the user and invoke resume logic separately.
 *
 * When `config.persistRuns` is false the function returns early — no session
 * entries were written, so there is nothing to restore.
 */
export function restoreOnSessionStart(
  sessionManager: SessionManager,
  config: { resumeInFlight: ResumeInFlight; persistRuns: boolean },
  store: Store,
  callbacks: RestoreCallbacks = {},
): void {
  if (!config.persistRuns) return;

  const getEntries = sessionManager.getEntries;
  if (typeof getEntries !== "function") return;

  const entries = getEntries.call(sessionManager);
  const sessionEntries = entries as readonly SessionEntry[];
  restoreTerminalRuns(sessionEntries, store);
  restoreBlockedRuns(sessionEntries, store);
  const inFlight = scanInFlightRuns(sessionEntries);
  if (inFlight.length === 0) return;

  for (const run of inFlight) {
    const runMeta = findRunStartMetadata(sessionEntries, run.runId);
    const stages = _buildStageSnapshots(sessionEntries, run.runId);

    if (config.resumeInFlight === "auto") {
      // Re-hydrate the run into the store as "running"
      const runSnapshot: RunSnapshot = {
        id: run.runId,
        name: run.name,
        inputs: run.inputs,
        status: "running",
        stages,
        startedAt: run.startTs,
        ...(runMeta.parentRunId !== undefined ? { parentRunId: runMeta.parentRunId } : {}),
        ...(runMeta.parentStageId !== undefined ? { parentStageId: runMeta.parentStageId } : {}),
        ...(runMeta.rootRunId !== undefined ? { rootRunId: runMeta.rootRunId } : {}),
        ...(runMeta.resumedFromRunId !== undefined ? { resumedFromRunId: runMeta.resumedFromRunId } : {}),
        ...(runMeta.resumeFromStageId !== undefined ? { resumeFromStageId: runMeta.resumeFromStageId } : {}),
      };
      store.recordRunStart(runSnapshot);
      callbacks.onResume?.(run);
    } else {
      // "ask" or "never": mark as crashed in store, surface to caller
      const runSnapshot: RunSnapshot = {
        id: run.runId,
        name: run.name,
        inputs: run.inputs,
        status: "failed",
        stages,
        startedAt: run.startTs,
        endedAt: Date.now(),
        error: "Run did not complete — process was interrupted.",
        failureKind: "unknown",
        resumable: false,
        ...(runMeta.parentRunId !== undefined ? { parentRunId: runMeta.parentRunId } : {}),
        ...(runMeta.parentStageId !== undefined ? { parentStageId: runMeta.parentStageId } : {}),
        ...(runMeta.rootRunId !== undefined ? { rootRunId: runMeta.rootRunId } : {}),
        ...(runMeta.resumedFromRunId !== undefined ? { resumedFromRunId: runMeta.resumedFromRunId } : {}),
        ...(runMeta.resumeFromStageId !== undefined ? { resumeFromStageId: runMeta.resumeFromStageId } : {}),
      };
      store.recordRunStart(runSnapshot);
      store.recordRunEnd(run.runId, "failed");
      callbacks.onCrashed?.(run);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Rebuild partial StageSnapshot array from session entries for a given run. */
interface BlockedStageFailureMetadata {
  readonly error?: string;
  readonly failureKind?: WorkflowFailureKind;
  readonly failureCode?: string;
  readonly failureRecoverability?: WorkflowFailureRecoverability;
  readonly failureDisposition?: WorkflowFailureDisposition;
  readonly failureMessage?: string;
  readonly retryAfterMs?: number;
}

function _buildStageSnapshots(
  entries: readonly SessionEntry[],
  runId: string,
  options: { finalize?: "crashed" | "blocked"; failedStageId?: string; blockedFailure?: BlockedStageFailureMetadata } = {},
): StageSnapshot[] {
  const stageMap = new Map<string, StageSnapshot>();
  const endedStages = new Set<string>();

  for (const entry of entries) {
    if (entry.payload["runId"] !== runId) continue;

    if (entry.type === "workflow.stage.start") {
      const stageId = entry.payload["stageId"];
      const name = entry.payload["name"];
      const parentIds = entry.payload["parentIds"];
      const ts = entry.payload["ts"];
      if (typeof stageId !== "string" || typeof name !== "string") continue;
      if (!stageMap.has(stageId)) {
        stageMap.set(stageId, {
          id: stageId,
          name,
          status: "running",
          parentIds: Array.isArray(parentIds) ? (parentIds as string[]) : [],
          startedAt: typeof ts === "number" ? ts : undefined,
          ...replayMetadata(entry.payload),
          toolEvents: [],
        });
      }
    }

    if (entry.type === "workflow.stage.end") {
      const stageId = entry.payload["stageId"];
      const status = entry.payload["status"];
      const durationMs = entry.payload["durationMs"];
      const summary = entry.payload["summary"];
      const error = entry.payload["error"];
      const failureKind = entry.payload["failureKind"];
      const failureCode = entry.payload["failureCode"];
      const failureRecoverability = entry.payload["failureRecoverability"];
      const failureDisposition = entry.payload["failureDisposition"];
      const failureMessage = entry.payload["failureMessage"];
      const retryAfterMs = entry.payload["retryAfterMs"];
      const skippedReason = entry.payload["skippedReason"];
      if (typeof stageId !== "string") continue;
      endedStages.add(stageId);
      const snap = stageMap.get(stageId);
      if (snap) {
        snap.status = restoreStageStatus(status);
        if (typeof durationMs === "number") snap.durationMs = durationMs;
        if (typeof summary === "string") snap.result = summary;
        if (typeof error === "string") snap.error = error;
        if (typeof failureKind === "string" && isWorkflowFailureKind(failureKind)) snap.failureKind = failureKind;
        if (typeof failureCode === "string") snap.failureCode = failureCode;
        if (isWorkflowFailureRecoverability(failureRecoverability)) snap.failureRecoverability = failureRecoverability;
        if (isWorkflowFailureDisposition(failureDisposition)) snap.failureDisposition = failureDisposition;
        if (typeof failureMessage === "string") snap.failureMessage = failureMessage;
        if (typeof retryAfterMs === "number") snap.retryAfterMs = retryAfterMs;
        if (typeof skippedReason === "string") snap.skippedReason = skippedReason;
        Object.assign(snap, replayMetadata(entry.payload), workflowChildMetadata(entry.payload));
      }
    }
  }

  const finalize = options.finalize ?? "crashed";
  for (const [stageId, snap] of stageMap) {
    if (endedStages.has(stageId)) continue;
    if (finalize === "blocked") {
      if (options.failedStageId !== undefined && stageId === options.failedStageId) {
        snap.status = "failed";
        applyBlockedFailureMetadata(snap, options.blockedFailure);
        continue;
      }
      const blockerId = findBlockingStageId(stageId, stageMap, endedStages, options.failedStageId);
      if (blockerId !== undefined) {
        snap.status = "blocked";
        snap.blockedByStageId = blockerId;
        continue;
      }
      snap.status = "running";
      continue;
    }
    snap.status = "failed";
    snap.error = "Stage did not complete — process was interrupted.";
  }

  return [...stageMap.values()];
}

function applyBlockedFailureMetadata(snap: StageSnapshot, metadata: BlockedStageFailureMetadata | undefined): void {
  if (metadata === undefined) return;
  if (metadata.error !== undefined) snap.error = metadata.error;
  if (metadata.failureKind !== undefined) snap.failureKind = metadata.failureKind;
  if (metadata.failureCode !== undefined) snap.failureCode = metadata.failureCode;
  if (metadata.failureRecoverability !== undefined) snap.failureRecoverability = metadata.failureRecoverability;
  if (metadata.failureDisposition !== undefined) snap.failureDisposition = metadata.failureDisposition;
  if (metadata.failureMessage !== undefined) snap.failureMessage = metadata.failureMessage;
  if (metadata.retryAfterMs !== undefined) snap.retryAfterMs = metadata.retryAfterMs;
}

function findBlockingStageId(
  stageId: string,
  stageMap: ReadonlyMap<string, StageSnapshot>,
  endedStages: ReadonlySet<string>,
  failedStageId?: string,
): string | undefined {
  if (failedStageId === undefined) return undefined;
  if (stageId === failedStageId) return undefined;
  const visited = new Set<string>();
  const queue = [...(stageMap.get(stageId)?.parentIds ?? [])];
  while (queue.length > 0) {
    const parentId = queue.shift();
    if (parentId === undefined || visited.has(parentId)) continue;
    visited.add(parentId);
    if (parentId === failedStageId) return parentId;
    const parent = stageMap.get(parentId);
    if (parent === undefined) continue;
    if (endedStages.has(parentId) && parent.status === "failed") return parentId;
    queue.push(...parent.parentIds);
  }
  return undefined;
}

function replayMetadata(payload: Record<string, unknown>): Pick<StageSnapshot, "replayKey" | "replayedFromStageId" | "replayed"> {
  const replayKey = payload["replayKey"];
  const replayedFromStageId = payload["replayedFromStageId"];
  const replayed = payload["replayed"];
  return {
    ...(typeof replayKey === "string" ? { replayKey } : {}),
    ...(typeof replayedFromStageId === "string" ? { replayedFromStageId } : {}),
    ...(typeof replayed === "boolean" ? { replayed } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serializableObject(value: unknown): WorkflowOutputValues | undefined {
  return Value.Check(workflowSerializableObjectSchema, value)
    ? (value as WorkflowOutputValues)
    : undefined;
}

function serializableObjectOrEmpty(value: unknown): WorkflowOutputValues {
  return serializableObject(value) ?? {};
}

function isWorkflowChildReplayStatus(status: unknown): status is WorkflowChildReplaySnapshot["status"] {
  return status === "completed";
}

function workflowChildMetadata(payload: Record<string, unknown>): Pick<StageSnapshot, "workflowChild"> {
  const workflowChild = payload["workflowChild"];
  if (!isRecord(workflowChild)) return {};
  const alias = workflowChild["alias"];
  const workflow = workflowChild["workflow"];
  const childRunId = workflowChild["runId"];
  const status = workflowChild["status"];
  const outputs = workflowChild["outputs"];
  if (
    typeof alias !== "string" ||
    typeof workflow !== "string" ||
    typeof childRunId !== "string" ||
    !isWorkflowChildReplayStatus(status) ||
    !isRecord(outputs)
  ) {
    return {};
  }

  // `structuredClone` detaches the restored snapshot from the parsed JSONL
  // payload with a guaranteed deep copy, independent of the TypeBox
  // serializable check. Declared `outputs` are the child contract, so a
  // non-serializable value bails the whole child snapshot.
  let clonedOutputs: WorkflowOutputValues;
  try {
    const serializableOutputs = serializableObject(outputs);
    if (serializableOutputs === undefined) return {};
    clonedOutputs = structuredClone(serializableOutputs);
  } catch {
    return {};
  }

  return {
    workflowChild: {
      alias,
      workflow,
      runId: childRunId,
      status,
      outputs: clonedOutputs,
    },
  };
}

function isWorkflowFailureRecoverability(value: unknown): value is NonNullable<RunSnapshot["failureRecoverability"]> {
  return value === "recoverable" || value === "non_recoverable" || value === "unknown";
}

function isWorkflowFailureDisposition(value: unknown): value is NonNullable<RunSnapshot["failureDisposition"]> {
  return value === "active_blocked" || value === "terminal_failed" || value === "terminal_killed";
}

function restoreFailureMetadata(payload: Record<string, unknown>): RunEndMetadata {
  const failureKind = payload["failureKind"];
  const failureCode = payload["failureCode"];
  const failureRecoverability = payload["failureRecoverability"];
  const failureDisposition = payload["failureDisposition"];
  const failureMessage = payload["failureMessage"];
  const retryAfterMs = payload["retryAfterMs"];
  const blockedAt = payload["blockedAt"];
  const failedStageId = payload["failedStageId"];
  const resumable = payload["resumable"];
  return {
    ...(typeof failureKind === "string" && isWorkflowFailureKind(failureKind) ? { failureKind } : {}),
    ...(typeof failureCode === "string" ? { failureCode } : {}),
    ...(isWorkflowFailureRecoverability(failureRecoverability) ? { failureRecoverability } : {}),
    ...(isWorkflowFailureDisposition(failureDisposition) ? { failureDisposition } : {}),
    ...(typeof failureMessage === "string" ? { failureMessage } : {}),
    ...(typeof retryAfterMs === "number" ? { retryAfterMs } : {}),
    ...(typeof blockedAt === "number" ? { blockedAt } : {}),
    ...(typeof failedStageId === "string" ? { failedStageId } : {}),
    ...(typeof resumable === "boolean" ? { resumable } : {}),
  };
}

function blockedStageFailureMetadata(error: string, metadata: RunEndMetadata): BlockedStageFailureMetadata {
  return {
    error,
    ...(metadata.failureKind !== undefined ? { failureKind: metadata.failureKind } : {}),
    ...(metadata.failureCode !== undefined ? { failureCode: metadata.failureCode } : {}),
    ...(metadata.failureRecoverability !== undefined ? { failureRecoverability: metadata.failureRecoverability } : {}),
    ...(metadata.failureDisposition !== undefined ? { failureDisposition: metadata.failureDisposition } : {}),
    ...(metadata.failureMessage !== undefined ? { failureMessage: metadata.failureMessage } : {}),
    ...(metadata.retryAfterMs !== undefined ? { retryAfterMs: metadata.retryAfterMs } : {}),
  };
}

function restoreStageStatus(status: unknown): StageStatus {
  switch (status) {
    case "completed":
    case "failed":
    case "skipped":
      return status;
    default:
      return "failed";
  }
}

function restoreBlockedRuns(entries: readonly SessionEntry[], store: Store): void {
  const started = new Map<string, { readonly name: string; readonly inputs: Readonly<WorkflowInputValues>; readonly startTs: number }>();
  const blocked = new Map<string, Record<string, unknown>>();
  const ended = new Set<string>();

  for (const entry of entries) {
    if (entry.type === "workflow.run.start") {
      const runId = entry.payload["runId"];
      const name = entry.payload["name"];
      const inputs = entry.payload["inputs"];
      const ts = entry.payload["ts"];
      if (typeof runId === "string" && typeof name === "string" && typeof ts === "number") {
        started.set(runId, {
          name,
          inputs: serializableObjectOrEmpty(inputs),
          startTs: ts,
        });
      }
    }
    if (entry.type === "workflow.run.blocked") {
      const runId = entry.payload["runId"];
      if (typeof runId === "string") blocked.set(runId, entry.payload);
    }
    if (entry.type === "workflow.run.end") {
      const runId = entry.payload["runId"];
      if (typeof runId === "string") ended.add(runId);
    }
  }

  for (const [runId, block] of blocked) {
    if (ended.has(runId)) continue;
    if (store.runs().some((run) => run.id === runId)) continue;
    const start = started.get(runId);
    if (start === undefined) continue;
    const error = block["error"];
    if (typeof error !== "string") continue;
    const failureMetadata = restoreFailureMetadata(block);
    const runMeta = findRunStartMetadata(entries, runId);
    const stages = _buildStageSnapshots(entries, runId, {
      finalize: "blocked",
      ...(failureMetadata.failedStageId !== undefined ? { failedStageId: failureMetadata.failedStageId } : {}),
      blockedFailure: blockedStageFailureMetadata(error, failureMetadata),
    });
    store.recordRunStart({
      id: runId,
      name: start.name,
      inputs: start.inputs,
      status: "running",
      stages,
      startedAt: start.startTs,
      ...(runMeta.parentRunId !== undefined ? { parentRunId: runMeta.parentRunId } : {}),
      ...(runMeta.parentStageId !== undefined ? { parentStageId: runMeta.parentStageId } : {}),
      ...(runMeta.rootRunId !== undefined ? { rootRunId: runMeta.rootRunId } : {}),
      ...(runMeta.resumedFromRunId !== undefined ? { resumedFromRunId: runMeta.resumedFromRunId } : {}),
      ...(runMeta.resumeFromStageId !== undefined ? { resumeFromStageId: runMeta.resumeFromStageId } : {}),
    });
    store.recordRunBlocked(runId, error, failureMetadata);
  }
}

function restoreTerminalRuns(entries: readonly SessionEntry[], store: Store): void {
  const started = new Map<string, { readonly name: string; readonly inputs: Readonly<WorkflowInputValues>; readonly startTs: number }>();
  const ended = new Map<string, Record<string, unknown>>();

  for (const entry of entries) {
    if (entry.type === "workflow.run.start") {
      const runId = entry.payload["runId"];
      const name = entry.payload["name"];
      const inputs = entry.payload["inputs"];
      const ts = entry.payload["ts"];
      if (typeof runId === "string" && typeof name === "string" && typeof ts === "number") {
        started.set(runId, {
          name,
          inputs: serializableObjectOrEmpty(inputs),
          startTs: ts,
        });
      }
    }
    if (entry.type === "workflow.run.end") {
      const runId = entry.payload["runId"];
      if (typeof runId === "string") ended.set(runId, entry.payload);
    }
  }

  for (const [runId, start] of started) {
    if (store.runs().some((run) => run.id === runId)) continue;
    const end = ended.get(runId);
    const status = restoreTerminalRunStatus(end?.["status"]);
    if (end === undefined || status === undefined) continue;

    const runMeta = findRunStartMetadata(entries, runId);
    const stages = _buildStageSnapshots(entries, runId);
    if (status === "completed" && stages.some((stage) => stage.status !== "completed")) continue;
    store.recordRunStart({
      id: runId,
      name: start.name,
      inputs: start.inputs,
      status: "running",
      stages,
      startedAt: start.startTs,
      ...(runMeta.parentRunId !== undefined ? { parentRunId: runMeta.parentRunId } : {}),
      ...(runMeta.parentStageId !== undefined ? { parentStageId: runMeta.parentStageId } : {}),
      ...(runMeta.rootRunId !== undefined ? { rootRunId: runMeta.rootRunId } : {}),
      ...(runMeta.resumedFromRunId !== undefined ? { resumedFromRunId: runMeta.resumedFromRunId } : {}),
      ...(runMeta.resumeFromStageId !== undefined ? { resumeFromStageId: runMeta.resumeFromStageId } : {}),
    });

    const error = end["error"];
    store.recordRunEnd(
      runId,
      status,
      undefined,
      typeof error === "string" ? error : undefined,
      restoreFailureMetadata(end),
    );
  }
}

function restoreTerminalRunStatus(status: unknown): "completed" | "failed" | "killed" | undefined {
  switch (status) {
    case "completed":
    case "failed":
    case "killed":
      return status;
    default:
      return undefined;
  }
}

function findRunStartMetadata(
  entries: readonly SessionEntry[],
  runId: string,
): {
  readonly parentRunId?: string;
  readonly parentStageId?: string;
  readonly rootRunId?: string;
  readonly resumedFromRunId?: string;
  readonly resumeFromStageId?: string;
} {
  for (const entry of entries) {
    if (entry.type !== "workflow.run.start" || entry.payload["runId"] !== runId) continue;
    const parentRunId = entry.payload["parentRunId"];
    const parentStageId = entry.payload["parentStageId"];
    const rootRunId = entry.payload["rootRunId"];
    const resumedFromRunId = entry.payload["resumedFromRunId"];
    const resumeFromStageId = entry.payload["resumeFromStageId"];
    return {
      ...(typeof parentRunId === "string" ? { parentRunId } : {}),
      ...(typeof parentStageId === "string" ? { parentStageId } : {}),
      ...(typeof rootRunId === "string" ? { rootRunId } : {}),
      ...(typeof resumedFromRunId === "string" ? { resumedFromRunId } : {}),
      ...(typeof resumeFromStageId === "string" ? { resumeFromStageId } : {}),
    };
  }
  return {};
}
