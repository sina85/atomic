/**
 * Preflight check for the deep-research-codebase workflow.
 *
 * Ensures uv is installed and CodeGraph is initialized/synced before agents spawn.
 * Called from the scout stage prelude in claude/index.ts, copilot/index.ts, opencode/index.ts.
 */

import { basename, extname } from "node:path";
import CodeGraph from "@colbymchenry/codegraph";
import { ensureUvInstalled } from "../../../../lib/spawn";

export type PreflightResult = {
  codegraphHealthy: boolean;
  uvAvailable: boolean;
  initialized: boolean;
  indexed: boolean;
  synced: boolean;
  supportedLanguageRatio: number;
  nodeCount: number;
  fileCount: number;
  reasons: string[];
};

/**
 * Minimum fraction of source files that must map to a CodeGraph-supported language
 * before we attempt to build the index.
 */
const CODEGRAPH_MIN_SUPPORTED_RATIO = 0.20;

/**
 * File extensions whose languages are supported by CodeGraph.
 * Source: https://github.com/colbymchenry/codegraph README + common language list.
 */
const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".rb",
  ".cpp", ".c", ".h", ".hpp",
  ".cs",
  ".php",
  ".swift",
  ".kt",
  ".scala",
]);

/**
 * Binary / lock-file extensions to exclude from the ratio calculation.
 */
const SKIP_EXTENSIONS = new Set([
  ".lock", ".sum",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
  ".pdf", ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z",
  ".db", ".sqlite", ".sqlite3",
  ".wasm",
  ".bin", ".exe", ".dll", ".so", ".dylib",
  ".map",
]);

/**
 * Pure helper: compute language ratio from an already-resolved file list.
 *
 * Extension is extracted via `extname(basename(file))` so dotted directory
 * segments (e.g. `pkg.with.dots/Makefile`) do NOT pollute the extension.
 *
 * Files with extensions in SKIP_EXTENSIONS are excluded from both numerator
 * and denominator so binaries / lock files don't dilute the ratio.
 */
export function computeLanguageRatio(files: string[]): {
  total: number;
  supported: number;
  ratio: number;
} {
  let total = 0;
  let supported = 0;

  for (const file of files) {
    const ext = extname(basename(file)).toLowerCase();
    if (ext === "") {
      total++;
      continue;
    }
    if (SKIP_EXTENSIONS.has(ext)) continue;
    total++;
    if (SUPPORTED_EXTENSIONS.has(ext)) supported++;
  }

  const ratio = total === 0 ? 0 : supported / total;
  return { total, supported, ratio };
}

/**
 * Walk source files via `git ls-files` and compute the fraction that map to a
 * CodeGraph-supported language.
 *
 * Files with extensions in SKIP_EXTENSIONS are excluded from both the numerator
 * and denominator so binaries / lock files don't dilute the ratio.
 */
async function calculateSupportedLanguageRatio(projectRoot: string): Promise<number> {
  const proc = Bun.spawn({
    cmd: ["git", "ls-files"],
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const files = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return computeLanguageRatio(files).ratio;
}

/**
 * Run the preflight check for the deep-research-codebase workflow.
 *
 * 1. Ensure uv is installed (needed for ast-grep MCP).
 * 2. Compute the supported language ratio; bail early if too low.
 * 3. Init or open CodeGraph, index or sync, capture stats, close.
 *
 * API note: the spec references `cg.status()` but the installed library exposes
 * `cg.getStats()` (synchronous, returns `GraphStats`). We use `getStats()` and
 * preserve the semantics described in the spec.
 */
export async function preflight(projectRoot: string): Promise<PreflightResult> {
  const reasons: string[] = [];
  let uvAvailable = true;

  try {
    await ensureUvInstalled({ quiet: true });
  } catch (e) {
    uvAvailable = false;
    reasons.push(
      `uv unavailable: ${(e as Error).message}; ast-grep MCP tools will be disabled`,
    );
  }

  const ratio = await calculateSupportedLanguageRatio(projectRoot);

  if (ratio < CODEGRAPH_MIN_SUPPORTED_RATIO) {
    reasons.push(
      `Codegraph skipped: only ${(ratio * 100).toFixed(0)}% of source files map to a supported language`,
    );
    return {
      codegraphHealthy: false,
      uvAvailable,
      initialized: false,
      indexed: false,
      synced: false,
      supportedLanguageRatio: ratio,
      nodeCount: 0,
      fileCount: 0,
      reasons,
    };
  }

  let cg: CodeGraph | null = null;
  try {
    const initialized = CodeGraph.isInitialized(projectRoot);
    cg = initialized
      ? await CodeGraph.open(projectRoot)
      : await CodeGraph.init(projectRoot);

    let indexed = false;
    let synced = false;

    if (!initialized) {
      await cg.indexAll();
      indexed = true;
    } else {
      await cg.sync();
      synced = true;
    }

    // spec says `cg.status()` — actual library method is `cg.getStats()` (sync)
    const stats = cg.getStats();

    return {
      codegraphHealthy: true,
      uvAvailable,
      initialized,
      indexed,
      synced,
      supportedLanguageRatio: ratio,
      nodeCount: stats.nodeCount,
      fileCount: stats.fileCount,
      reasons,
    };
  } catch (e) {
    reasons.push(`Codegraph unhealthy: ${(e as Error).message}`);
    return {
      codegraphHealthy: false,
      uvAvailable,
      initialized: false,
      indexed: false,
      synced: false,
      supportedLanguageRatio: ratio,
      nodeCount: 0,
      fileCount: 0,
      reasons,
    };
  } finally {
    if (cg !== null) cg.close();
  }
}
