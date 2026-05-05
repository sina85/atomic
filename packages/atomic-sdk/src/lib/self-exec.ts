/**
 * Helpers for re-executing the atomic CLI as a fresh sub-process.
 *
 * Mirrors OpenCode's single-binary model: every fresh-process entry into
 * atomic goes through `atomic _<subcommand>`. The launcher emits a
 * platform-appropriate command line that resolves to:
 *
 *   - **Compiled binary**: `<atomic-binary> _<subcommand> <args…>`
 *     (`process.execPath` is the binary itself; argv[0] is the subcommand)
 *
 *   - **Dev / installed-package runtime**: `<bun> <cli.ts> _<subcommand> <args…>`
 *     (`process.execPath` is the bun interpreter; the CLI script must be
 *     passed explicitly)
 *
 * Centralising the launcher construction here keeps every internal
 * sub-command (`_footer`, `_orchestrator-entry`, `_cc-debounce`, …) on a
 * single code path, so a fix to argv handling or escaping lands in one
 * place rather than drifting across call sites.
 */

import { posix, win32 } from "node:path";
import { isCompiledBinaryRuntime } from "./runtime-env.ts";

/** Escape a string for safe interpolation inside a bash double-quoted string. */
function escBash(s: string): string {
  return s
    .replace(/\x00/g, "")
    .replace(/[\n\r]+/g, " ")
    .replace(/[\\"$`!]/g, "\\$&");
}

/** Escape a string as a PowerShell single-quoted literal. */
function quotePwshLiteral(s: string): string {
  return `'${s
    .replace(/\x00/g, "")
    .replace(/[\n\r]+/g, " ")
    .replace(/'/g, "''")}'`;
}

/** Quote an argv token for bash. Flag names (`--foo`, `-x`) are emitted
 *  bare; every other token is always double-quoted, matching the
 *  existing launcher style. The "always quote values" rule keeps user
 *  data (paths, agent names, base64 payloads) safe regardless of
 *  content; the "bare flags" rule keeps emitted commands readable and
 *  matches the historical buildAttachedFooterCommand output. */
function quoteBashArg(s: string): string {
  return s.startsWith("-") ? s : `"${escBash(s)}"`;
}

/**
 * Resolve the absolute path to the atomic CLI entry script.
 *
 * In a compiled binary the CLI *is* the binary, so `process.execPath`
 * doubles as the runtime and the CLI. In dev / installed-package
 * runtime, walk up from `runtimeDir` (which is always
 * `packages/atomic-sdk/src/<somewhere>`) to
 * `packages/atomic/src/cli.ts`.
 */
export function resolveAtomicCliPath(
  runtimeDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (isCompiledBinaryRuntime(runtimeDir)) {
    return process.execPath;
  }
  const j = platform === "win32" ? win32.join : posix.join;
  // runtimeDir is packages/atomic-sdk/src/<lib|runtime>/.
  // Walk up to packages/, then down into atomic/src/cli.ts.
  return j(runtimeDir, "..", "..", "..", "atomic", "src", "cli.ts");
}

/**
 * Build a bash / pwsh command line that re-executes the atomic CLI with
 * the given internal sub-command and positional arguments. Use as the
 * argument to tmux's `new-session` / `split-window` / `run-shell`.
 *
 * `runtime` is typically `process.execPath`. When it equals `cliPath`
 * (compiled-binary case) we omit the script argument — Bun's compiled
 * binary already injects argv[1] = binary, so emitting it explicitly
 * would put a stray `<binary>` token in front of the subcommand and
 * Commander would mis-route the call.
 */
export function buildSelfExecCommand(opts: {
  runtime: string;
  cliPath: string;
  subcommand: string;
  args: readonly string[];
  platform?: NodeJS.Platform;
}): string {
  const { runtime, cliPath, subcommand, args, platform = process.platform } = opts;
  const isSelfExec = runtime === cliPath;

  if (platform === "win32") {
    const parts = [quotePwshLiteral(runtime)];
    if (!isSelfExec) parts.push(quotePwshLiteral(cliPath));
    parts.push(quotePwshLiteral(subcommand));
    for (const arg of args) parts.push(quotePwshLiteral(arg));
    return parts.join(" ");
  }

  const cliPart = isSelfExec ? "" : `"${escBash(cliPath)}" `;
  const argParts = args.map(quoteBashArg).join(" ");
  return (
    `"${escBash(runtime)}" ${cliPart}${subcommand}` +
    (argParts ? ` ${argParts}` : "")
  );
}
