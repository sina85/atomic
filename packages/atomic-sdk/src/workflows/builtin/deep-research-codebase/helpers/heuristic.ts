/** Target LOC per explorer sub-agent. */
const LOC_PER_EXPLORER = 5_000;

/**
 * Reduction factor applied to explorer count when CodeGraph MCP is healthy.
 * CodeGraph provides structural navigation that makes each explorer more
 * effective, so fewer explorers are needed.
 */
export const CODEGRAPH_EXPLORER_FACTOR = 0.7;

export interface HeuristicOpts {
  codegraphHealthy?: boolean;
}

/**
 * Determine how many parallel explorer sub-agents to spawn for the
 * deep-research-codebase workflow, based on lines of code in the codebase.
 *
 * Scales linearly: one explorer per `LOC_PER_EXPLORER` (5K) lines of code,
 * with a floor of 2 for tiny or empty codebases. The actual number of
 * spawned explorers is still bounded by the number of partition units
 * the scout finds (see `partitionUnits` in ./scout.ts), so we never get
 * more explorers than the natural granularity of the codebase allows.
 *
 * When `opts.codegraphHealthy` is true, the base count is reduced by
 * `CODEGRAPH_EXPLORER_FACTOR` because CodeGraph structural navigation
 * makes each explorer more effective.
 */
export function calculateExplorerCount(
  loc: number,
  opts: HeuristicOpts = {},
): number {
  if (!Number.isFinite(loc) || loc <= 0) return 2;
  const base = Math.max(2, Math.ceil(loc / LOC_PER_EXPLORER));
  if (opts.codegraphHealthy === true) {
    return Math.max(2, Math.ceil(base * CODEGRAPH_EXPLORER_FACTOR));
  }
  return base;
}

/** Human-readable rationale for the heuristic decision — surfaced in logs/prompts. */
export function explainHeuristic(loc: number, count: number): string {
  return `Codebase: ${loc.toLocaleString()} LOC → spawning ${count} parallel explorer${
    count === 1 ? "" : "s"
  }.`;
}
