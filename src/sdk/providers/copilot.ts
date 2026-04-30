/**
 * Copilot workflow source validation + helpers.
 *
 * Checks that Copilot workflow source files use the runtime-managed
 * `s.client` and `s.session` instead of manual SDK client creation.
 */

import type { CopilotClientOptions, SessionConfig as CopilotSessionConfig } from "@github/copilot-sdk";
import { normalizedTerminalEnv } from "../../lib/terminal-env.ts";
import { getCommandPath } from "../../services/system/detect.ts";
import { createProviderValidator } from "../types.ts";

/**
 * Env inherited by the Copilot CLI subprocess the SDK spawns.
 *
 * `NODE_NO_WARNINGS=1` silences the
 * `ExperimentalWarning: SQLite is an experimental feature` banner that
 * Node prints via the CLI's bundled `require("node:sqlite")`. The SDK
 * pipes the subprocess's stderr through `process.stderr` with a
 * `[CLI subprocess]` prefix, so without this override the warning
 * leaks into every `atomic chat -a copilot` and `atomic workflow -a
 * copilot` invocation.
 *
 * Also normalizes UTF-8 locale and terminal defaults via
 * {@link normalizedTerminalEnv} so the CLI subprocess inherits sane
 * values regardless of the host shell's configuration.
 *
 * The SDK uses `options.env ?? process.env` as-is (no merge) when
 * spawning, so we must fold the existing env in ourselves. Returns a
 * fresh object per call so callers can layer additional env without
 * mutating shared state.
 */
export function copilotSubprocessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  return { ...normalizedTerminalEnv(baseEnv), NODE_NO_WARNINGS: "1" };
}

/**
 * Resolve the absolute path to the Copilot CLI executable.
 *
 * Precedence:
 * 1. `COPILOT_CLI_PATH` env var — if set and non-empty.
 * 2. `getCommandPath('copilot')` — resolved via `Bun.which`.
 * 3. `undefined` — let the SDK use its bundled instance.
 *
 * Does NOT validate by spawning; SDK start surfaces executable errors.
 */
export function resolveCopilotCliPath(): string | undefined {
  const envPath = process.env["COPILOT_CLI_PATH"];
  if (envPath) return envPath;
  const resolved = getCommandPath("copilot");
  return resolved ?? undefined;
}

/**
 * Build options suitable for `new CopilotClient(...)`.
 *
 * Includes:
 * - `env` from {@link copilotSubprocessEnv} (UTF-8 locale + `NODE_NO_WARNINGS=1`).
 * - `cliPath` from {@link resolveCopilotCliPath} when resolvable; omitted
 *   otherwise so the SDK falls back to its bundled CLI.
 */
export function copilotSdkLaunchOptions(): CopilotClientOptions {
  const options: CopilotClientOptions = {
    env: copilotSubprocessEnv(),
  };
  const cliPath = resolveCopilotCliPath();
  if (cliPath !== undefined) {
    options.cliPath = cliPath;
  }
  return options;
}

/**
 * Fold the atomic-managed additional instructions into a caller's
 * `systemMessage` value on `client.createSession`. Behavior:
 *
 *   - **No caller value** → `{ mode: "append", content: extra }`. The
 *     SDK's default mode is append and preserves the SDK persona.
 *   - **Append/customize mode** → concatenate our content to the existing
 *     `content` field (newline-separated when both are present).
 *   - **Replace mode** → leave alone. The caller has explicitly opted out
 *     of SDK-managed sections; silently re-adding the persona-style append
 *     would violate that contract.
 *
 * Exported for unit testing.
 */
export function mergeCopilotSystemMessage(
  existing: CopilotSessionConfig["systemMessage"],
  extra: string,
): CopilotSessionConfig["systemMessage"] {
  if (!extra) return existing;
  if (existing === undefined) {
    return { mode: "append", content: extra };
  }
  if (existing.mode === "replace") return existing;
  const prev = existing.content ?? "";
  const merged = prev ? `${prev}\n\n${extra}` : extra;
  return { ...existing, content: merged };
}

/**
 * Validate a Copilot workflow source file for common mistakes.
 */
export const validateCopilotWorkflow = createProviderValidator([
  {
    pattern: /\bnew\s+CopilotClient\b/,
    rule: "copilot/manual-client",
    message:
      "Manual CopilotClient creation detected. Use s.client instead — " +
      "the runtime auto-creates and cleans up the client.",
  },
  {
    pattern: /\bclient\.createSession\b/,
    rule: "copilot/manual-session",
    message:
      "Manual createSession() call detected. Use s.session instead — " +
      "the runtime auto-creates the session. Pass session config as the third arg to ctx.stage().",
  },
]);
