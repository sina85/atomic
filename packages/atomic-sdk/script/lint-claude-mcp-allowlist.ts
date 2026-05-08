/**
 * lint-claude-mcp-allowlist.ts
 *
 * CI lint: every .claude/agents/*.md that declares `mcpServers:` in YAML
 * frontmatter must enumerate each server in `tools:` via the pattern
 * `mcp__<server>__*` or `mcp__<server>`.
 *
 * Additional invariants (RFC §5.5 Cluster D1):
 * 1. OpenCode tools invariant — .opencode/opencode.json agent tool grants
 * 2. Forbidden-substring invariant — 18 agent files must not contain stale phrases
 * 3. Copilot tools[] invariant — .github/agents/codebase-*.md frontmatter shape
 *
 * Usage:
 *   bun run script/lint-claude-mcp-allowlist.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ParsedFrontmatter {
  mcpServers: string[]; // top-level keys under mcpServers:
  tools: string[];      // individual tool tokens
}

/**
 * Parse YAML frontmatter between leading `---` delimiters.
 * Returns raw frontmatter lines (without the `---` delimiters).
 */
export function extractFrontmatterLines(content: string): string[] | null {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const endIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (endIdx === -1) return null;
  return lines.slice(1, endIdx);
}

/**
 * Parse server names from `mcpServers:` block.
 * Top-level keys under `mcpServers:` are indented by exactly 2 spaces (one
 * level). We collect lines that follow `mcpServers:` with indent=2 and are
 * key: value or key: (block) entries.
 */
export function parseMcpServers(lines: string[]): string[] {
  const servers: string[] = [];
  let inMcpServers = false;

  for (const line of lines) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    if (line.trim() === "mcpServers:") {
      inMcpServers = true;
      continue;
    }

    if (inMcpServers) {
      // Top-level keys under mcpServers: have indent == 2
      if (indent === 0) {
        // Back to root level — done
        inMcpServers = false;
        continue;
      }
      if (indent === 2) {
        // e.g. "  codegraph:" or "  ast-grep:"
        const match = line.trim().match(/^([^:]+):/);
        if (match) {
          servers.push(match[1].trim());
        }
      }
      // deeper indent = nested config, skip
    }
  }

  return servers;
}

/**
 * Parse tool names from `tools:` line.
 * Supports both:
 *   tools: Grep, Glob, mcp__foo__*, ...   (inline comma-separated)
 *   tools:\n  - Grep\n  - Glob            (YAML block-list)
 */
export function parseTools(lines: string[]): string[] {
  const tools: string[] = [];
  let inTools = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const inlineMatch = line.match(/^tools:\s*(.+)/);
    if (inlineMatch && trimmed !== "tools:") {
      return inlineMatch[1].split(",").map((t) => t.trim()).filter(Boolean);
    }
    if (trimmed === "tools:") { inTools = true; continue; }
    if (inTools) {
      if (trimmed.length === 0) continue;            // blank line — keep block open
      const indent = line.length - line.trimStart().length;
      if (indent === 0) { inTools = false; continue; }
      const itemMatch = trimmed.match(/^-\s*(.+)/);
      if (itemMatch) tools.push(itemMatch[1].trim().replace(/^["']|["']$/g, ""));
    }
  }
  return tools;
}

export function parseFrontmatter(content: string): ParsedFrontmatter | null {
  const fmLines = extractFrontmatterLines(content);
  if (!fmLines) return null;

  const mcpServers = parseMcpServers(fmLines);
  const hasMcpServersKey = fmLines.some((l) => l.trim() === "mcpServers:");
  if (mcpServers.length === 0 && !hasMcpServersKey) return null;

  return { mcpServers, tools: parseTools(fmLines) };
}

/**
 * Check if `tools` allowlist covers `server`.
 * Match: exact `mcp__<server>` OR any `mcp__<server>__*` (including the
 * literal wildcard token, which trivially starts with the same prefix).
 */
export function serverCoveredByTools(server: string, tools: string[]): boolean {
  const exact = `mcp__${server}`;
  const prefix = `mcp__${server}__`;
  return tools.some((tool) => tool === exact || tool.startsWith(prefix));
}

/**
 * Lint all agent files in `agentsDir`. Returns array of error strings.
 */
export function lintAgentsDir(agentsDir: string): string[] {
  let files: string[];
  try {
    files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [`error: cannot read agents directory: ${agentsDir}`];
  }

  const errors: string[] = [];

  for (const filename of files) {
    const filePath = join(agentsDir, filename);
    const content = readFileSync(filePath, "utf8");

    const parsed = parseFrontmatter(content);
    if (!parsed) continue; // no mcpServers declared — skip

    const { mcpServers, tools } = parsed;

    if (mcpServers.length === 0) {
      errors.push(
        `${filePath}: 'mcpServers:' key declared with no children — declare at least one server entry or remove the key`
      );
      continue;
    }

    for (const server of mcpServers) {
      if (!serverCoveredByTools(server, tools)) {
        errors.push(
          `error: ${filePath}: missing tool pattern mcp__${server}__* (or mcp__${server}) for declared mcpServer "${server}"`
        );
      }
    }
  }

  return errors;
}

// ── OpenCode tools invariant ──────────────────────────────────────────────────

interface OpenCodeAgentTools {
  [key: string]: boolean;
}

interface OpenCodeAgent {
  tools?: OpenCodeAgentTools;
}

interface OpenCodeConfig {
  tools?: Record<string, boolean>;
  agent?: {
    [agentName: string]: OpenCodeAgent;
  };
}

const CODEBASE_AGENTS_NON_RESEARCHER = [
  "codebase-analyzer",
  "codebase-locator",
  "codebase-pattern-finder",
  "codebase-research-locator",
  "codebase-research-analyzer",
] as const;

export function lintOpenCodeToolsInvariant(openCodeJsonPath: string): string[] {
  const errors: string[] = [];

  let config: OpenCodeConfig;
  try {
    const raw = readFileSync(openCodeJsonPath, "utf8");
    config = JSON.parse(raw) as OpenCodeConfig;
  } catch (e) {
    return [`error: cannot read/parse ${openCodeJsonPath}: ${String(e)}`];
  }

  // B1: top-level tools deny block — must explicitly deny both MCP servers globally
  const topTools = config.tools ?? {};
  if (topTools["codegraph*"] !== false) {
    errors.push(
      `${openCodeJsonPath}: top-level tools["codegraph*"] must be false (deny block), got ${JSON.stringify(topTools["codegraph*"])}`
    );
  }
  if (topTools["ast-grep*"] !== false) {
    errors.push(
      `${openCodeJsonPath}: top-level tools["ast-grep*"] must be false (deny block), got ${JSON.stringify(topTools["ast-grep*"])}`
    );
  }

  const agent = config.agent ?? {};

  // codebase-online-researcher: ast-grep* === false, codegraph* === true
  const researcher = agent["codebase-online-researcher"];
  if (!researcher) {
    errors.push(`${openCodeJsonPath}: missing agent["codebase-online-researcher"]`);
  } else {
    const tools = researcher.tools ?? {};
    if (tools["ast-grep*"] !== false) {
      errors.push(
        `${openCodeJsonPath}: agent["codebase-online-researcher"].tools["ast-grep*"] must be false, got ${JSON.stringify(tools["ast-grep*"])}`
      );
    }
    if (tools["codegraph*"] !== true) {
      errors.push(
        `${openCodeJsonPath}: agent["codebase-online-researcher"].tools["codegraph*"] must be true, got ${JSON.stringify(tools["codegraph*"])}`
      );
    }
  }

  // Other five codebase-* agents: both codegraph* and ast-grep* must be true
  for (const agentName of CODEBASE_AGENTS_NON_RESEARCHER) {
    const agentCfg = agent[agentName];
    if (!agentCfg) {
      errors.push(`${openCodeJsonPath}: missing agent["${agentName}"]`);
      continue;
    }
    const tools = agentCfg.tools ?? {};
    if (tools["codegraph*"] !== true) {
      errors.push(
        `${openCodeJsonPath}: agent["${agentName}"].tools["codegraph*"] must be true, got ${JSON.stringify(tools["codegraph*"])}`
      );
    }
    if (tools["ast-grep*"] !== true) {
      errors.push(
        `${openCodeJsonPath}: agent["${agentName}"].tools["ast-grep*"] must be true, got ${JSON.stringify(tools["ast-grep*"])}`
      );
    }
  }

  return errors;
}

// ── Forbidden-substring invariant ─────────────────────────────────────────────

const FORBIDDEN_SUBSTRINGS = [
  "NEVER call `codegraph_explore`",
  "Instead, ALWAYS spawn an Explore agent",
  "When spawning Explore agents",
  "The main session may only use these lightweight tools directly",
] as const;

/**
 * List `codebase-*.md` files in a directory. Returns null if the directory
 * cannot be read so callers can distinguish "no matches" from "missing dir".
 */
function listCodebaseAgentFiles(dir: string): string[] | null {
  try {
    return readdirSync(dir).filter(
      (f) => f.startsWith("codebase-") && f.endsWith(".md")
    );
  } catch {
    return null;
  }
}

export function lintForbiddenSubstrings(filePath: string): string[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (e) {
    return [`error: cannot read ${filePath}: ${String(e)}`];
  }

  const lines = content.split("\n");
  const errors: string[] = [];
  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    const idx = lines.findIndex((l) => l.includes(forbidden));
    if (idx >= 0) {
      errors.push(`${filePath}:${idx + 1}: forbidden substring "${forbidden}"`);
    }
  }
  return errors;
}

export function lintForbiddenSubstringsDir(
  repoRoot: string,
  agentDirs: string[]
): string[] {
  const errors: string[] = [];
  for (const dir of agentDirs) {
    const agentsDir = join(repoRoot, dir);
    const files = listCodebaseAgentFiles(agentsDir);
    if (files === null) {
      errors.push(`error: cannot read agents directory: ${agentsDir}`);
      continue;
    }
    for (const filename of files) {
      errors.push(...lintForbiddenSubstrings(join(agentsDir, filename)));
    }
  }
  return errors;
}

// ── Copilot tools[] invariant ─────────────────────────────────────────────────

/**
 * Parse YAML frontmatter `mcp-servers:` block.
 * Returns map of server-name → { command, args }.
 */
export function parseCopilotMcpServers(
  lines: string[]
): Map<string, { command: string; args: string[] }> {
  const result = new Map<string, { command: string; args: string[] }>();
  let inMcpServers = false;
  let currentServer: string | null = null;
  let currentCommand = "";
  let currentArgs: string[] = [];
  let inArgs = false;

  const flush = () => {
    if (currentServer) {
      result.set(currentServer, { command: currentCommand, args: currentArgs });
    }
    currentServer = null;
    currentCommand = "";
    currentArgs = [];
    inArgs = false;
  };

  for (const line of lines) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    if (line.trim() === "mcp-servers:") {
      inMcpServers = true;
      continue;
    }

    if (inMcpServers) {
      if (indent === 0) {
        flush();
        inMcpServers = false;
        continue;
      }
      if (indent === 2) {
        // New server entry
        flush();
        const match = line.trim().match(/^([^:]+):/);
        if (match) currentServer = match[1].trim();
        inArgs = false;
        continue;
      }
      if (indent === 4 && currentServer) {
        const trimmed = line.trim();
        const cmdMatch = trimmed.match(/^command:\s*(.+)/);
        if (cmdMatch) {
          currentCommand = cmdMatch[1].trim();
          inArgs = false;
          continue;
        }
        // Inline JSON array args: args: ["serve", "--mcp"]
        const inlineArgsMatch = trimmed.match(/^args:\s*\[(.+)\]/);
        if (inlineArgsMatch) {
          currentArgs = inlineArgsMatch[1]
            .split(",")
            .map((s) => s.trim().replace(/^["']|["']$/g, ""))
            .filter((s) => s.length > 0);
          inArgs = false;
          continue;
        }
        if (trimmed === "args:") {
          inArgs = true;
          currentArgs = [];
          continue;
        }
        // key: value (type, etc.) — skip
        inArgs = false;
        continue;
      }
      if (indent === 6 && currentServer && inArgs) {
        // YAML list item: "- value"
        const itemMatch = line.trim().match(/^-\s*(.+)/);
        if (itemMatch) currentArgs.push(itemMatch[1].trim().replace(/^["']|["']$/g, ""));
        continue;
      }
    }
  }
  flush();
  return result;
}

/**
 * Parse `tools:` from frontmatter — supports both:
 *   tools: ["a", "b", "c"]
 *   tools:\n  - a\n  - b
 */
export function parseCopilotTools(lines: string[]): string[] {
  const tools: string[] = [];
  let inTools = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Inline JSON array: tools: ["a", "b"]
    const inlineMatch = line.match(/^tools:\s*\[(.+)\]/);
    if (inlineMatch) {
      const items = inlineMatch[1].split(",").map((s) =>
        s.trim().replace(/^["']|["']$/g, "")
      );
      tools.push(...items.filter((s) => s.length > 0));
      return tools;
    }

    // Block list start: tools:
    if (trimmed === "tools:") {
      inTools = true;
      continue;
    }

    if (inTools) {
      if (trimmed.length === 0) continue;            // blank line — keep block open
      const indent = line.length - line.trimStart().length;
      if (indent === 0) {
        inTools = false;
        continue;
      }
      const itemMatch = trimmed.match(/^-\s*(.+)/);
      if (itemMatch) {
        tools.push(itemMatch[1].trim().replace(/^["']|["']$/g, ""));
      }
    }
  }

  return tools;
}

export function lintCopilotAgentFile(filePath: string, filename: string): string[] {
  const errors: string[] = [];
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (e) {
    return [`error: cannot read ${filePath}: ${String(e)}`];
  }

  const fmLines = extractFrontmatterLines(content);
  if (!fmLines) {
    errors.push(`${filePath}:1: missing YAML frontmatter`);
    return errors;
  }

  const isOnlineResearcher = filename.includes("codebase-online-researcher");
  const mcpServers = parseCopilotMcpServers(fmLines);
  const tools = parseCopilotTools(fmLines);

  // Assert codegraph entry: command: codegraph, args: ["serve","--mcp"]
  const cg = mcpServers.get("codegraph");
  if (!cg) {
    errors.push(`${filePath}:1: mcp-servers missing "codegraph" entry`);
  } else {
    if (cg.command !== "codegraph") {
      errors.push(
        `${filePath}:1: mcp-servers.codegraph.command must be "codegraph", got "${cg.command}"`
      );
    }
    const expectedArgs = ["serve", "--mcp"];
    if (JSON.stringify(cg.args) !== JSON.stringify(expectedArgs)) {
      errors.push(
        `${filePath}:1: mcp-servers.codegraph.args must be ["serve","--mcp"], got ${JSON.stringify(cg.args)}`
      );
    }
  }

  // Non-online-researcher must also have ast-grep entry
  if (!isOnlineResearcher) {
    const ag = mcpServers.get("ast-grep");
    if (!ag) {
      errors.push(`${filePath}:1: mcp-servers missing "ast-grep" entry`);
    }
  }

  // tools[] must contain codegraph/*
  if (!tools.some((t) => t === "codegraph/*")) {
    errors.push(`${filePath}:1: tools[] missing "codegraph/*"`);
  }

  // Non-online-researcher: tools[] must contain ast-grep/*
  if (!isOnlineResearcher && !tools.some((t) => t === "ast-grep/*")) {
    errors.push(`${filePath}:1: tools[] missing "ast-grep/*"`);
  }

  return errors;
}

export function lintCopilotAgentsDir(githubAgentsDir: string): string[] {
  const files = listCodebaseAgentFiles(githubAgentsDir);
  if (files === null) {
    return [`error: cannot read agents directory: ${githubAgentsDir}`];
  }

  const errors: string[] = [];
  for (const filename of files) {
    errors.push(...lintCopilotAgentFile(join(githubAgentsDir, filename), filename));
  }
  return errors;
}

// ── Main ──────────────────────────────────────────────────────────────────────

// Guard: only run main block when executed directly (not imported by tests)
if (import.meta.path === Bun.main) {
  const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
  const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
  const AGENTS_DIR = join(REPO_ROOT, ".claude", "agents");

  // Early readability check — fast-fail before running invariants
  try {
    readdirSync(AGENTS_DIR);
  } catch {
    console.error(`error: cannot read agents directory: ${AGENTS_DIR}`);
    process.exit(1);
  }

  const openCodePath = join(REPO_ROOT, ".opencode", "opencode.json");
  const forbiddenDirs = [".claude/agents", ".github/agents", ".opencode/agents"];
  const copilotAgentsDir = join(REPO_ROOT, ".github", "agents");

  const claudeErrors = lintAgentsDir(AGENTS_DIR);
  const openCodeErrors = lintOpenCodeToolsInvariant(openCodePath);
  const forbiddenErrors = lintForbiddenSubstringsDir(REPO_ROOT, forbiddenDirs);
  const copilotErrors = lintCopilotAgentsDir(copilotAgentsDir);

  const allErrors = [...claudeErrors, ...openCodeErrors, ...forbiddenErrors, ...copilotErrors];

  if (allErrors.length > 0) {
    for (const err of allErrors) console.error(err);
    process.exit(1);
  }

  // Count files for per-invariant status
  const claudeFiles = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).length;
  const copilotFiles = listCodebaseAgentFiles(copilotAgentsDir)?.length ?? 0;
  const forbiddenFiles = forbiddenDirs.reduce(
    (sum, dir) => sum + (listCodebaseAgentFiles(join(REPO_ROOT, dir))?.length ?? 0),
    0,
  );

  console.log(`lint:mcp: all 4 invariants pass`);
  console.log(`  1. Claude mcpServers↔tools allowlist: ${claudeFiles} files`);
  console.log(`  2. OpenCode tools toggle: ${openCodePath}`);
  console.log(`  3. Forbidden substrings: ${forbiddenFiles} files across ${forbiddenDirs.length} dirs`);
  console.log(`  4. Copilot mcp-servers + tools[]: ${copilotFiles} files`);
  process.exit(0);
}
