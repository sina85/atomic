/** Read-only durable completed workflow opener for `/workflow resume`. */

import { existsSync } from "node:fs";
import type { DurableCheckpoint, DurableStageCheckpoint, ResumableWorkflowEntry, WorkflowSerializableObject } from "./types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { resolveDurableEntry } from "./resume-runtime.js";
import type { Store } from "../shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import type { WorkflowInputValues } from "../shared/types.js";

export type OpenCompletedDurableResult =
  | { ok: true; runId: string; workflowId: string; name: string; message: string }
  | { ok: false; reason: "not_found" | "ambiguous" | "stale"; message: string };

interface StageDraft {
  readonly key: string;
  readonly name: string;
  readonly firstCompletedAt: number;
  readonly output?: DurableStageCheckpoint["output"];
  readonly sessionId?: string;
  readonly sessionFile?: string;
}

export function listOpenableCompletedWorkflows(backend: DurableWorkflowBackend): readonly ResumableWorkflowEntry[] {
  return backend.listCompletedWorkflows().filter((entry) => completedWorkflowSnapshot(backend, entry) !== undefined);
}

export function openCompletedDurableWorkflow(
  workflowIdOrPrefix: string,
  deps: { readonly durableBackend: DurableWorkflowBackend; readonly store: Store },
  catalog?: readonly ResumableWorkflowEntry[],
): OpenCompletedDurableResult {
  const backend = deps.durableBackend;
  const resolved = resolveDurableEntry(workflowIdOrPrefix, catalog ?? listOpenableCompletedWorkflows(backend));
  if (resolved === undefined) {
    return { ok: false, reason: "not_found", message: `No completed durable workflow found for id/prefix: ${workflowIdOrPrefix}` };
  }
  if ("kind" in resolved) {
    return {
      ok: false,
      reason: "ambiguous",
      message: `Ambiguous completed workflow prefix "${workflowIdOrPrefix}" matches: ${resolved.matches.map((m) => `${m.name} (${m.workflowId.slice(0, 8)})`).join(", ")}`,
    };
  }
  const snapshot = completedWorkflowSnapshot(backend, resolved);
  if (snapshot === undefined) {
    return {
      ok: false,
      reason: "stale",
      message: `Completed workflow ${resolved.workflowId.slice(0, 8)} is stale or missing durable checkpoint/session data and cannot be opened.`,
    };
  }
  const existing = deps.store.runs().find((run) => run.id === snapshot.id);
  if (existing !== undefined) {
    if (existing.status === "completed") {
      return completedOpenResult(existing.id, existing.name);
    }
    if (existing.endedAt === undefined && existing.status !== "paused") {
      return {
        ok: false,
        reason: "stale",
        message: `Workflow ${snapshot.id.slice(0, 8)} is already active in this session; attach with /workflow connect ${snapshot.id.slice(0, 8)} instead.`,
      };
    }
    deps.store.removeRun(existing.id);
  }
  deps.store.recordRunStart(snapshot);
  return completedOpenResult(snapshot.id, snapshot.name);
}

function completedOpenResult(runId: string, name: string): OpenCompletedDurableResult {
  return {
    ok: true,
    runId,
    workflowId: runId,
    name,
    message: `Opened completed durable workflow "${name}" (${runId.slice(0, 8)}) for inspection.`,
  };
}

function completedWorkflowSnapshot(backend: DurableWorkflowBackend, entry: ResumableWorkflowEntry): RunSnapshot | undefined {
  const handle = backend.getWorkflow(entry.workflowId);
  if (handle === undefined || handle.status !== "completed") return undefined;
  const checkpoints = backend.listCheckpoints(entry.workflowId);
  if (checkpoints.length === 0) return undefined;
  if (!hasAvailableSessionFiles(checkpoints)) return undefined;
  const stages = stageSnapshotsFromCheckpoints(checkpoints, handle.updatedAt);
  return {
    id: handle.workflowId,
    name: handle.name,
    inputs: { ...(handle.inputs as WorkflowSerializableObject) } as WorkflowInputValues,
    status: "completed",
    stages,
    startedAt: handle.createdAt,
    endedAt: handle.updatedAt,
    durationMs: Math.max(0, handle.updatedAt - handle.createdAt),
    resumable: false,
  };
}

function hasAvailableSessionFiles(checkpoints: readonly DurableCheckpoint[]): boolean {
  return checkpoints.every((checkpoint) => {
    if (checkpoint.kind !== "stage" || checkpoint.sessionFile === undefined) return true;
    return existsSync(checkpoint.sessionFile);
  });
}

function stageSnapshotsFromCheckpoints(checkpoints: readonly DurableCheckpoint[], fallbackCompletedAt: number): StageSnapshot[] {
  const drafts = new Map<string, StageDraft>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.kind !== "stage") continue;
    const key = checkpoint.replayKey;
    const existing = drafts.get(key);
    drafts.set(key, {
      key,
      name: existing?.name ?? checkpoint.name,
      firstCompletedAt: Math.min(existing?.firstCompletedAt ?? checkpoint.completedAt, checkpoint.completedAt),
      ...("output" in checkpoint ? { output: checkpoint.output } : existing?.output !== undefined ? { output: existing.output } : {}),
      ...(checkpoint.sessionId !== undefined ? { sessionId: checkpoint.sessionId } : existing?.sessionId !== undefined ? { sessionId: existing.sessionId } : {}),
      ...(checkpoint.sessionFile !== undefined ? { sessionFile: checkpoint.sessionFile } : existing?.sessionFile !== undefined ? { sessionFile: existing.sessionFile } : {}),
    });
  }
  const stageDrafts = [...drafts.values()].sort((a, b) => a.firstCompletedAt - b.firstCompletedAt);
  if (stageDrafts.length > 0) return stageDrafts.map((draft, index) => stageSnapshotFromDraft(draft, index));
  return [syntheticCheckpointStage(checkpoints.length, fallbackCompletedAt)];
}

function stageSnapshotFromDraft(draft: StageDraft, index: number): StageSnapshot {
  return {
    id: `durable-stage-${index + 1}`,
    name: draft.name,
    status: "completed",
    parentIds: [],
    startedAt: draft.firstCompletedAt,
    endedAt: draft.firstCompletedAt,
    durationMs: 0,
    ...(draft.output !== undefined ? { result: stringifyOutput(draft.output) } : {}),
    replayKey: draft.key,
    toolEvents: [],
    attachable: false,
    ...(draft.sessionId !== undefined ? { sessionId: draft.sessionId } : {}),
    ...(draft.sessionFile !== undefined ? { sessionFile: draft.sessionFile } : {}),
  };
}

function syntheticCheckpointStage(checkpointCount: number, completedAt: number): StageSnapshot {
  return {
    id: "durable-checkpoints",
    name: "durable checkpoints",
    status: "completed",
    parentIds: [],
    startedAt: completedAt,
    endedAt: completedAt,
    durationMs: 0,
    result: `${checkpointCount} durable checkpoint${checkpointCount === 1 ? "" : "s"}`,
    toolEvents: [],
    attachable: false,
  };
}

function stringifyOutput(value: DurableStageCheckpoint["output"]): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
