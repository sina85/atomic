/**
 * lint-file-discovery.ts
 *
 * CI lint: no file outside `helpers/file-discovery.ts` may contain a
 * `Bun.spawn(` or `Bun.spawnSync(` call whose `cmd` array contains both
 * the literal strings `"git"` AND `"ls-files"`.
 *
 * Scope (RFC §8.3 / Q17): scans only
 *   packages/atomic-sdk/src/workflows/builtin/deep-research-codebase/helpers/
 *
 * Usage:
 *   bun run script/lint-file-discovery.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Violation {
  file: string;
  line: number;
  match: string;
}

/**
 * Regex patterns that detect a Bun.spawn / Bun.spawnSync whose cmd array
 * contains both "git" and "ls-files" (in either order).
 *
 * Pattern explanation (multi-line, greedy-enough to bridge `cmd: [`):
 *   Bun\.spawn(?:Sync)?\s*\(\s*\{   — opening of spawn call with options object
 *   [\s\S]*?                         — any content (non-greedy)
 *   cmd\s*:\s*\[                     — cmd: [ array start
 *   [^\]]*?                          — array contents (no closing bracket)
 *   ["']git["']                      — literal "git" or 'git'
 *   [^\]]*?                          — more array contents
 *   ["']ls-files["']                 — literal "ls-files" or 'ls-files'
 *   [^\]]*?\]                        — rest of array + closing bracket
 *
 * A second pattern handles reversed order (ls-files before git).
 */
const PATTERNS: RegExp[] = [
  // "git" ... "ls-files"
  /Bun\.spawn(?:Sync)?\s*\(\s*\{[\s\S]*?cmd\s*:\s*\[[^\]]*?["']git["'][^\]]*?["']ls-files["'][^\]]*?\]/g,
  // "ls-files" ... "git"  (reversed order)
  /Bun\.spawn(?:Sync)?\s*\(\s*\{[\s\S]*?cmd\s*:\s*\[[^\]]*?["']ls-files["'][^\]]*?["']git["'][^\]]*?\]/g,
];

/**
 * Pure check function. Scans `rootDir` for `.ts` / `.tsx` files.
 * Files in `allowlist` (basename) are skipped.
 *
 * Returns array of Violation objects (one per matched pattern occurrence).
 */
export function scanForViolations(
  rootDir: string,
  allowlist: Set<string>,
): Violation[] {
  let filenames: string[];
  try {
    filenames = readdirSync(rootDir).filter(
      (f) => f.endsWith(".ts") || f.endsWith(".tsx"),
    );
  } catch (e) {
    process.stderr.write(`error: cannot read directory: ${rootDir}: ${String(e)}\n`);
    return [];
  }

  const violations: Violation[] = [];

  for (const filename of filenames) {
    if (allowlist.has(filename)) continue;

    const filePath = join(rootDir, filename);
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (e) {
      process.stderr.write(`error: cannot read ${filePath}: ${String(e)}\n`);
      continue;
    }

    const lines = content.split("\n");

    for (const pattern of PATTERNS) {
      // Reset lastIndex for global regex before each file.
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;

      while ((m = pattern.exec(content)) !== null) {
        // Compute 1-based line number from match offset.
        const matchOffset = m.index;
        const lineNum = content.slice(0, matchOffset).split("\n").length;
        violations.push({
          file: filePath,
          line: lineNum,
          match: lines[lineNum - 1]?.trim() ?? m[0].slice(0, 80),
        });
      }
    }
  }

  return violations;
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (import.meta.path === Bun.main) {
  const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
  const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
  const HELPERS_DIR = join(
    REPO_ROOT,
    "packages",
    "atomic-sdk",
    "src",
    "workflows",
    "builtin",
    "deep-research-codebase",
    "helpers",
  );

  const ALLOWLIST = new Set<string>(["file-discovery.ts"]);

  const violations = scanForViolations(HELPERS_DIR, ALLOWLIST);

  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(
        `error: ${v.file}:${v.line}: forbidden Bun.spawn/spawnSync with git ls-files outside allowlist\n`,
      );
    }
    process.exit(1);
  }

  process.stdout.write(
    `lint:file-discovery: all helpers/*.ts files pass (git ls-files spawn not found outside allowlist)\n`,
  );
  process.exit(0);
}
