/**
 * `ctx.monitor` runtime primitive and deterministic stage-lifecycle controller.
 *
 * A monitor is a pure-observation side-effect primitive backed by the Pi/Atomic
 * intercom package. It starts automatically when a monitored stage transitions
 * to running and stops automatically when every monitored stage reaches a
 * terminal state (completed/failed/skipped). Multi-stage monitors use
 * reference-counted aggregate liveness: start on the first monitored stage
 * becoming active, remain live while any monitored stage is still running,
 * stop when none are active. Monitors are NOT durable checkpoints and never
 * start on durable-replayed stages (replay bypasses the live stage-lifecycle
 * paths that drive these hooks).
 *
 * cross-ref: issue #1497.
 */

import type {
  WorkflowMonitorHandle,
  WorkflowMonitorLifecycleInfo,
  WorkflowMonitorOptions,
  WorkflowMonitorPrimitive,
} from "../../shared/types.js";

/** Dedicated intercom event name for monitor lifecycle emissions. */
export const WORKFLOW_MONITOR_INTERCOM_EVENT = "workflow:monitor-intercom";

/** Minimal intercom transport port — structurally compatible with WorkflowResultIntercomPort. */
export interface WorkflowMonitorIntercomPort {
  emit?: (event: string, payload: Record<string, unknown>) => void;
}

/**
 * Port injected into the foreground stage factory. The executor calls these
 * hooks from deterministic stage-lifecycle points; the controller coordinates
 * ref-counted start/stop across all ctx.monitor registrations.
 */
export interface MonitorLifecyclePort {
  /** Called when a live stage transitions to status "running". */
  onStageRunning(runId: string, stageId: string, stageName: string): void;
  /** Called when a live stage reaches a terminal status (single owner). */
  onStageTerminal(runId: string, stageId: string, stageName: string, status: "completed" | "failed" | "skipped"): void;
}

interface MonitorRegistration {
  readonly stages: readonly string[];
  readonly options: WorkflowMonitorOptions;
  readonly channel: string;
  activeCount: number;
  isLive: boolean;
}

export interface CreateWorkflowMonitorInput {
  readonly runId: string;
  readonly intercom?: WorkflowMonitorIntercomPort;
}

export interface WorkflowMonitorRuntime {
  readonly monitor: WorkflowMonitorPrimitive;
  readonly lifecycle: MonitorLifecyclePort;
}

function normalizeStages(stages: string | readonly string[]): readonly string[] {
  const arr = typeof stages === "string" ? [stages] : [...stages];
  if (arr.length === 0) {
    throw new Error("atomic-workflows: ctx.monitor requires at least one stage name");
  }
  for (const name of arr) {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("atomic-workflows: ctx.monitor stage names must be non-empty strings");
    }
  }
  return arr;
}

function defaultChannel(stages: readonly string[]): string {
  return `workflow-monitor:${stages.join(",")}`;
}

/**
 * Creates the ctx.monitor primitive and its deterministic lifecycle controller.
 * The primitive is injected into WorkflowRunContext.monitor; the lifecycle port
 * is threaded into the foreground executor so monitor start/stop is driven
 * entirely by stage-lifecycle transitions, not by manual author calls.
 */
export function createWorkflowMonitorPrimitive(input: CreateWorkflowMonitorInput): WorkflowMonitorRuntime {
  const registrations: MonitorRegistration[] = [];

  const emit = (
    kind: "start" | "stop",
    reg: MonitorRegistration,
    info: { readonly stageId?: string; readonly stageName?: string; readonly status?: string },
  ): void => {
    const emitFn = input.intercom?.emit;
    if (emitFn === undefined) return;
    const payload: Record<string, unknown> = {
      kind,
      runId: input.runId,
      channel: reg.channel,
      createdAt: Date.now(),
      ...(info.stageId !== undefined ? { stageId: info.stageId } : {}),
      ...(info.stageName !== undefined ? { stageName: info.stageName } : {}),
      ...(info.status !== undefined ? { status: info.status } : {}),
      ...(reg.options.label !== undefined ? { label: reg.options.label } : {}),
    };
    emitFn(WORKFLOW_MONITOR_INTERCOM_EVENT, payload);
  };

  const lifecycle: MonitorLifecyclePort = {
    onStageRunning(runId, stageId, stageName) {
      for (const reg of registrations) {
        if (!reg.stages.includes(stageName)) continue;
        reg.activeCount += 1;
        if (!reg.isLive && reg.activeCount > 0) {
          reg.isLive = true;
          const info: WorkflowMonitorLifecycleInfo = { runId, stageId, stageName, channel: reg.channel };
          void reg.options.onStart?.(info);
          emit("start", reg, { stageId, stageName });
        }
      }
    },
    onStageTerminal(runId, stageId, stageName, status) {
      for (const reg of registrations) {
        if (!reg.stages.includes(stageName)) continue;
        if (reg.activeCount > 0) reg.activeCount -= 1;
        if (reg.isLive && reg.activeCount === 0) {
          reg.isLive = false;
          const info: WorkflowMonitorLifecycleInfo & { readonly status: "completed" | "failed" | "skipped" } = {
            runId,
            stageId,
            stageName,
            channel: reg.channel,
            status,
          };
          void reg.options.onStop?.(info);
          emit("stop", reg, { stageId, stageName, status });
        }
      }
    },
  };

  const monitor: WorkflowMonitorPrimitive = (stages, options): WorkflowMonitorHandle => {
    const normalized = normalizeStages(stages);
    const channel = options?.channel ?? defaultChannel(normalized);
    registrations.push({
      stages: normalized,
      options: options ?? {},
      channel,
      activeCount: 0,
      isLive: false,
    });
    return { stages: normalized };
  };

  return { monitor, lifecycle };
}
