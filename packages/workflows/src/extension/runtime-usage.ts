import type { WorkflowExecutionPolicy, WorkflowUsageRollupPort } from "../shared/types.js";

export interface RuntimeDispatchOptions {
  readonly policy?: WorkflowExecutionPolicy;
  /** Parent session that launched this run; captured before asynchronous stage completion. */
  readonly rootSessionId?: string;
}

export function bindUsageRollupRoot(
  port: WorkflowUsageRollupPort | undefined,
  rootSessionId: string | undefined,
): WorkflowUsageRollupPort | undefined {
  if (!port || !rootSessionId) return port;
  return {
    emitStageRollup(stageId, usage, meta): void {
      port.emitStageRollup(stageId, usage, { ...meta, rootSessionId });
    },
  };
}
