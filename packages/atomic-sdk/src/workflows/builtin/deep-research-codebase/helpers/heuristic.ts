import { readFileSync, statSync } from "node:fs";

/** Target LOC per explorer sub-agent. */
const LOC_PER_EXPLORER = 5_000;

/**
 * Determine how many parallel explorer sub-agents to spawn for the
 * deep-research-codebase workflow, based on lines of code in the codebase.
 *
 * Scales linearly: one explorer per `LOC_PER_EXPLORER` (5K) lines of code,
 * with a floor of 2 for tiny or empty codebases. The actual number of
 * spawned explorers is still bounded by the number of partition units
 * the scout finds (see `partitionUnits` in ./scout.ts), so we never get
 * more explorers than the natural granularity of the codebase allows.
 */
export function calculateExplorerCount(loc: number): number {
  if (!Number.isFinite(loc) || loc <= 0) return 2;
  return Math.max(2, Math.ceil(loc / LOC_PER_EXPLORER));
}

/** Human-readable rationale for the heuristic decision — surfaced in logs/prompts. */
export function explainHeuristic(loc: number, count: number): string {
  return `Codebase: ${loc.toLocaleString()} LOC → spawning ${count} parallel explorer${
    count === 1 ? "" : "s"
  }.`;
}

/**
 * Minimum byte size we trust as a real research document. The mandated YAML
 * frontmatter alone is ~300 bytes; a document with any actual findings clears
 * this comfortably. Conservative on purpose — this only catches empty stubs or
 * a short error string the agent wrote on itself, not legitimately terse reports.
 */
const MIN_RESEARCH_DOC_BYTES = 500;

/**
 * Verify the aggregator actually produced a usable research document at
 * `finalPath`, rather than reporting success without writing the artifact (or
 * writing an empty / truncated stub). Checks: the file exists, clears a
 * conservative size floor, and opens with YAML frontmatter (`---`) as
 * `buildAggregatorPrompt()`'s OUTPUT_FORMAT requires. Returns `false` instead
 * of throwing on any filesystem error so callers can treat "not verifiable"
 * the same as "missing".
 */
export function aggregatorOutputComplete(finalPath: string): boolean {
  try {
    if (statSync(finalPath).size < MIN_RESEARCH_DOC_BYTES) return false;
    return readFileSync(finalPath, "utf8").trimStart().startsWith("---");
  } catch {
    return false;
  }
}
