/**
 * Extension-side wiring for the shared post-mortem stage-chat resolver.
 *
 * Builds `PostMortemStageChatDeps` from live extension runtime surfaces
 * (stage adapters, durable per-run cwd, and the default stage session dir after
 * a host restart) so both the TUI attach pane and `workflow send` revive an
 * eligible terminal agent stage through the same detached, single-flight
 * resolver instead of process-local handle presence alone.
 *
 * cross-ref:
 *   - src/runs/foreground/postmortem-stage-chat.ts (resolver)
 *   - src/tui/overlay-adapter.ts (attach pane wiring)
 *   - src/extension/workflow-tool-send.ts (send parity)
 */
import { store } from "../shared/store.js";
import { getDurableBackend } from "../durable/factory.js";
import {
  ensurePostMortemStageHandle,
  type PostMortemStageChatDeps,
} from "../runs/foreground/postmortem-stage-chat.js";
import { stageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import type { StageControlHandle } from "../runs/foreground/stage-control-registry.js";
import type { StageAdapters } from "../runs/foreground/stage-runner.js";

export interface PostMortemResolverDeps {
  readonly adapters: StageAdapters;
  readonly resolveDefaultStageSessionDir: () => string | undefined;
}

/** Persisted original/resolved cwd for a durable run, when still available. */
function resolveStageCwd(runId: string): string | undefined {
  try {
    const handle = getDurableBackend().getWorkflow(runId);
    return handle?.workflowCwd ?? handle?.invocationCwd ?? undefined;
  } catch {
    return undefined;
  }
}

/** Resolver deps for a specific run, keyed so revived handles use the real run cwd. */
export function postMortemDepsForRun(
  runId: string,
  deps: PostMortemResolverDeps,
): PostMortemStageChatDeps {
  return {
    registry: stageControlRegistry,
    adapters: deps.adapters,
    cwd: resolveStageCwd(runId),
    defaultSessionDir: deps.resolveDefaultStageSessionDir(),
  };
}

/**
 * Build a `(runId, stageId) => handle | undefined` resolver for the attach pane.
 * Returns `undefined` when the stage is unknown or not revivable so the pane
 * keeps its read-only transcript fallback.
 */
export function createPostMortemHandleResolver(
  deps: PostMortemResolverDeps,
): (runId: string, stageId: string) => StageControlHandle | undefined {
  return (runId, stageId) => {
    const run = store.snapshot().runs.find((candidate) => candidate.id === runId);
    const stage = run?.stages.find((candidate) => candidate.id === stageId);
    if (stage === undefined) return undefined;
    const result = ensurePostMortemStageHandle(runId, stage, postMortemDepsForRun(runId, deps));
    return result.ok ? result.handle : undefined;
  };
}
