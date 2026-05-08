import { test, expect, describe } from "bun:test";
import {
  extractFrontmatterLines,
  parseMcpServers,
  parseTools,
  parseFrontmatter,
  serverCoveredByTools,
  lintAgentsDir,
  lintForbiddenSubstrings,
  lintOpenCodeToolsInvariant,
  parseCopilotTools,
  parseCopilotMcpServers,
} from "./lint-claude-mcp-allowlist";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── extractFrontmatterLines ───────────────────────────────────────────────────

describe("extractFrontmatterLines", () => {
  test("returns lines between --- delimiters", () => {
    const content = "---\nname: foo\ntools: Bar\n---\n\nbody";
    const lines = extractFrontmatterLines(content);
    expect(lines).toEqual(["name: foo", "tools: Bar"]);
  });

  test("returns null when no leading ---", () => {
    expect(extractFrontmatterLines("name: foo\n---")).toBeNull();
  });

  test("returns null when closing --- missing", () => {
    expect(extractFrontmatterLines("---\nname: foo\n")).toBeNull();
  });
});

// ── parseMcpServers ───────────────────────────────────────────────────────────

describe("parseMcpServers", () => {
  test("extracts single server", () => {
    const lines = [
      "name: agent",
      "mcpServers:",
      "  codegraph:",
      "    type: stdio",
    ];
    expect(parseMcpServers(lines)).toEqual(["codegraph"]);
  });

  test("extracts multiple servers including hyphenated name", () => {
    const lines = [
      "mcpServers:",
      "  codegraph:",
      "    type: stdio",
      "  ast-grep:",
      "    type: stdio",
    ];
    expect(parseMcpServers(lines)).toEqual(["codegraph", "ast-grep"]);
  });

  test("stops at root-level key after mcpServers block", () => {
    const lines = [
      "mcpServers:",
      "  codegraph:",
      "    type: stdio",
      "model: haiku",
    ];
    expect(parseMcpServers(lines)).toEqual(["codegraph"]);
  });

  test("returns empty array when no mcpServers block", () => {
    const lines = ["name: agent", "tools: Bash"];
    expect(parseMcpServers(lines)).toEqual([]);
  });

  test("F1 symmetry: blank line between server entries does not terminate block", () => {
    const lines = [
      "mcpServers:",
      "  codegraph:",
      "    type: stdio",
      "",
      "  ast-grep:",
      "    type: stdio",
    ];
    expect(parseMcpServers(lines)).toEqual(["codegraph", "ast-grep"]);
  });
});

// ── parseTools ────────────────────────────────────────────────────────────────

describe("parseTools", () => {
  test("parses comma-separated tools", () => {
    const lines = ["name: agent", "tools: Grep, Glob, mcp__codegraph__*"];
    expect(parseTools(lines)).toEqual(["Grep", "Glob", "mcp__codegraph__*"]);
  });

  test("returns empty array when no tools line", () => {
    expect(parseTools(["name: agent"])).toEqual([]);
  });

  test("trims whitespace around tokens", () => {
    const lines = ["tools:  Bash ,  Edit "];
    expect(parseTools(lines)).toEqual(["Bash", "Edit"]);
  });

  // B2 — block-list form
  test("block-list: parses YAML list items under tools:", () => {
    const lines = ["tools:", "  - Grep", "  - Glob", "  - mcp__codegraph__*"];
    expect(parseTools(lines)).toEqual(["Grep", "Glob", "mcp__codegraph__*"]);
  });

  test("block-list: empty tools: with no children returns []", () => {
    const lines = ["name: agent", "tools:"];
    expect(parseTools(lines)).toEqual([]);
  });

  test("block-list: unindented key after list terminates block", () => {
    const lines = ["tools:", "  - Grep", "name: agent"];
    expect(parseTools(lines)).toEqual(["Grep"]);
  });

  test("inline regression: tools: Bash, Edit still works", () => {
    const lines = ["tools: Bash, Edit"];
    expect(parseTools(lines)).toEqual(["Bash", "Edit"]);
  });

  test("block-list: strips surrounding quotes from items", () => {
    const lines = ["tools:", '  - "Grep"', "  - 'Glob'"];
    expect(parseTools(lines)).toEqual(["Grep", "Glob"]);
  });

  test("F1 regression: blank line between block-list items keeps block open", () => {
    const lines = ["tools:", "  - Grep", "", "  - Glob"];
    expect(parseTools(lines)).toEqual(["Grep", "Glob"]);
  });
});

// ── parseFrontmatter ──────────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  test("returns null when no frontmatter delimiters", () => {
    expect(parseFrontmatter("no frontmatter here")).toBeNull();
  });

  test("returns null when no mcpServers key", () => {
    const content = "---\nname: agent\ntools: Bash\n---\nbody";
    expect(parseFrontmatter(content)).toBeNull();
  });

  test("parses mcpServers and tools together", () => {
    const content = [
      "---",
      "name: agent",
      "tools: Bash, mcp__codegraph__*",
      "mcpServers:",
      "  codegraph:",
      "    type: stdio",
      "---",
      "body",
    ].join("\n");
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result?.mcpServers).toEqual(["codegraph"]);
    expect(result?.tools).toContain("mcp__codegraph__*");
  });
});

// ── serverCoveredByTools ──────────────────────────────────────────────────────

describe("serverCoveredByTools", () => {
  test("matches exact mcp__<server>", () => {
    expect(serverCoveredByTools("codegraph", ["mcp__codegraph"])).toBe(true);
  });

  test("matches wildcard mcp__<server>__*", () => {
    expect(serverCoveredByTools("codegraph", ["mcp__codegraph__*"])).toBe(true);
  });

  test("matches specific sub-tool mcp__<server>__<name>", () => {
    expect(serverCoveredByTools("codegraph", ["mcp__codegraph__search"])).toBe(true);
  });

  test("does not match other server", () => {
    expect(serverCoveredByTools("ast-grep", ["mcp__codegraph__*"])).toBe(false);
  });

  test("handles hyphenated server name", () => {
    expect(serverCoveredByTools("ast-grep", ["mcp__ast-grep__*"])).toBe(true);
  });

  test("returns false when tools list empty", () => {
    expect(serverCoveredByTools("codegraph", [])).toBe(false);
  });

  test("does not match prefix-only overlap", () => {
    // mcp__code should NOT match mcp__codegraph
    expect(serverCoveredByTools("code", ["mcp__codegraph__*"])).toBe(false);
  });
});

// ── lintAgentsDir (integration) ───────────────────────────────────────────────

describe("lintAgentsDir", () => {
  function makeTmpDir(): string {
    const dir = join(tmpdir(), `lint-mcp-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeAgent(dir: string, name: string, content: string) {
    writeFileSync(join(dir, name), content, "utf8");
  }

  test("returns empty errors when all agents pass", () => {
    const dir = makeTmpDir();
    try {
      writeAgent(dir, "agent.md", [
        "---",
        "name: agent",
        "tools: Bash, mcp__codegraph__*, mcp__ast-grep__*",
        "mcpServers:",
        "  codegraph:",
        "    type: stdio",
        "  ast-grep:",
        "    type: stdio",
        "---",
        "body",
      ].join("\n"));

      const errors = lintAgentsDir(dir);
      expect(errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns error when server missing from tools", () => {
    const dir = makeTmpDir();
    try {
      writeAgent(dir, "bad-agent.md", [
        "---",
        "name: bad",
        "tools: Bash, mcp__codegraph__*",
        "mcpServers:",
        "  codegraph:",
        "    type: stdio",
        "  ast-grep:",
        "    type: stdio",
        "---",
        "body",
      ].join("\n"));

      const errors = lintAgentsDir(dir);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("ast-grep");
      expect(errors[0]).toContain("bad-agent.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips files without mcpServers", () => {
    const dir = makeTmpDir();
    try {
      writeAgent(dir, "no-mcp.md", [
        "---",
        "name: agent",
        "tools: Bash",
        "---",
        "body",
      ].join("\n"));

      const errors = lintAgentsDir(dir);
      expect(errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips non-.md files", () => {
    const dir = makeTmpDir();
    try {
      writeAgent(dir, "readme.txt", "mcpServers:\n  bad:\n");
      const errors = lintAgentsDir(dir);
      expect(errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("emits error when mcpServers key present but has no children", () => {
    const dir = makeTmpDir();
    try {
      writeAgent(dir, "empty-mcp.md", [
        "---",
        "name: agent",
        "tools: Bash",
        "mcpServers:",
        "---",
        "body",
      ].join("\n"));

      const errors = lintAgentsDir(dir);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("empty-mcp.md");
      expect(errors[0]).toContain("mcpServers:");
      expect(errors[0]).toContain("no children");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not emit empty-key error when mcpServers key absent", () => {
    const dir = makeTmpDir();
    try {
      writeAgent(dir, "no-mcp-key.md", [
        "---",
        "name: agent",
        "tools: Bash",
        "---",
        "body",
      ].join("\n"));

      const errors = lintAgentsDir(dir);
      expect(errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not emit empty-key error when mcpServers has children", () => {
    const dir = makeTmpDir();
    try {
      writeAgent(dir, "good-mcp.md", [
        "---",
        "name: agent",
        "tools: Bash, mcp__codegraph__*",
        "mcpServers:",
        "  codegraph:",
        "    type: stdio",
        "---",
        "body",
      ].join("\n"));

      const errors = lintAgentsDir(dir);
      expect(errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("errors for multiple missing servers", () => {
    const dir = makeTmpDir();
    try {
      writeAgent(dir, "two-missing.md", [
        "---",
        "name: agent",
        "tools: Bash",
        "mcpServers:",
        "  codegraph:",
        "    type: stdio",
        "  ast-grep:",
        "    type: stdio",
        "---",
      ].join("\n"));

      const errors = lintAgentsDir(dir);
      expect(errors).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("F3: error message uses passed agentsDir, not hardcoded .claude/agents/", () => {
    const dir = makeTmpDir();
    // dir is NOT `.claude/agents` — it's a tmpdir-based path
    try {
      writeAgent(dir, "bad-agent.md", [
        "---",
        "name: bad",
        "tools: Bash, mcp__codegraph__*",
        "mcpServers:",
        "  codegraph:",
        "    type: stdio",
        "  ast-grep:",
        "    type: stdio",
        "---",
      ].join("\n"));

      const errors = lintAgentsDir(dir);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(dir);
      expect(errors[0]).toContain("bad-agent.md");
      // Must NOT contain the hardcoded literal
      expect(errors[0]).not.toContain(".claude/agents/bad-agent.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── parseCopilotTools (Q18 symmetry) ─────────────────────────────────────────

describe("parseCopilotTools (Q18 symmetry)", () => {
  test("F1 symmetry: blank line between block-list items keeps block open", () => {
    const lines = ["tools:", "  - codegraph/*", "", "  - ast-grep/*"];
    expect(parseCopilotTools(lines)).toEqual(["codegraph/*", "ast-grep/*"]);
  });

  test("F1 symmetry: inline JSON-array form unaffected by guard", () => {
    const lines = ["tools: [\"codegraph/*\", \"ast-grep/*\"]"];
    expect(parseCopilotTools(lines)).toEqual(["codegraph/*", "ast-grep/*"]);
  });
});

// ── parseCopilotMcpServers (Q18 symmetry) ────────────────────────────────────

describe("parseCopilotMcpServers (Q18 symmetry)", () => {
  test("blank line between server entries does not terminate block", () => {
    const lines = [
      "mcp-servers:",
      "  codegraph:",
      "    command: codegraph",
      "    args: [\"serve\", \"--mcp\"]",
      "",
      "  ast-grep:",
      "    command: uvx",
      "    args: [\"ast-grep-mcp\"]",
    ];
    const result = parseCopilotMcpServers(lines);
    expect(result.has("codegraph")).toBe(true);
    expect(result.has("ast-grep")).toBe(true);
  });
});

// ── RFC §8.3: lintForbiddenSubstrings ────────────────────────────────────────

describe("lintForbiddenSubstrings (RFC §8.3)", () => {
  function makeTmpFile(name: string, content: string): string {
    const dir = join(tmpdir(), `lint-fs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, name);
    writeFileSync(filePath, content, "utf8");
    return filePath;
  }

  test("known-good agent file returns no violations", () => {
    const filePath = makeTmpFile("codebase-analyzer.md", [
      "---",
      "name: codebase-analyzer",
      "tools: Grep, Glob, Read",
      "---",
      "# Codebase Analyzer",
      "",
      "Use CodeGraph and ast-grep MCP tools to analyze the codebase.",
      "Call codegraph_search to find symbols.",
    ].join("\n"));

    try {
      const violations = lintForbiddenSubstrings(filePath);
      expect(violations).toEqual([]);
    } finally {
      rmSync(filePath, { force: true });
    }
  });

  test("agent file with 'NEVER call `codegraph_explore`' returns violation with file:line", () => {
    const content = [
      "---",
      "name: codebase-locator",
      "tools: Grep",
      "---",
      "# Locator",
      "",
      "NEVER call `codegraph_explore` directly.",
      "Use other tools instead.",
    ].join("\n");
    const filePath = makeTmpFile("codebase-locator.md", content);

    try {
      const violations = lintForbiddenSubstrings(filePath);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      // Must include file path and line number in the format "filePath:lineNum:"
      const msg = violations[0];
      expect(msg).toContain(filePath);
      // Line 7 contains the forbidden string (1-indexed)
      expect(msg).toMatch(/:\d+:/);
      expect(msg).toContain("NEVER call `codegraph_explore`");
    } finally {
      rmSync(filePath, { force: true });
    }
  });
});

// ── RFC §8.3: lintOpenCodeToolsInvariant ─────────────────────────────────────

describe("lintOpenCodeToolsInvariant (RFC §8.3)", () => {
  function makeTmpOpenCodeJson(content: object): string {
    const dir = join(tmpdir(), `lint-oc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "opencode.json");
    writeFileSync(filePath, JSON.stringify(content, null, 2), "utf8");
    return filePath;
  }

  // B1 — top-level tools deny block
  test("B1: missing top-level tools block produces 2 errors (codegraph* and ast-grep*)", () => {
    const config = {
      mcp: {},
      agent: {
        "codebase-online-researcher": {
          tools: { "ast-grep*": false, "codegraph*": true },
        },
        "codebase-analyzer": {
          tools: { "codegraph*": true, "ast-grep*": true },
        },
        "codebase-locator": {
          tools: { "codegraph*": true, "ast-grep*": true },
        },
        "codebase-pattern-finder": {
          tools: { "codegraph*": true, "ast-grep*": true },
        },
        "codebase-research-locator": {
          tools: { "codegraph*": true, "ast-grep*": true },
        },
        "codebase-research-analyzer": {
          tools: { "codegraph*": true, "ast-grep*": true },
        },
      },
    };

    const filePath = makeTmpOpenCodeJson(config);
    try {
      const errors = lintOpenCodeToolsInvariant(filePath);
      // Exactly 2 top-level-deny errors (one per key)
      const topLevelErrors = errors.filter((e) => e.includes("top-level tools"));
      expect(topLevelErrors).toHaveLength(2);
      const combined = topLevelErrors.join("\n");
      expect(combined).toContain("codegraph*");
      expect(combined).toContain("ast-grep*");
    } finally {
      rmSync(filePath, { force: true });
    }
  });

  test("B1: top-level tools with wrong values (true) produces 2 errors with JSON.stringify'd value", () => {
    const config = {
      tools: { "codegraph*": true, "ast-grep*": true },
      agent: {
        "codebase-online-researcher": {
          tools: { "ast-grep*": false, "codegraph*": true },
        },
        "codebase-analyzer": {
          tools: { "codegraph*": true, "ast-grep*": true },
        },
        "codebase-locator": {
          tools: { "codegraph*": true, "ast-grep*": true },
        },
        "codebase-pattern-finder": {
          tools: { "codegraph*": true, "ast-grep*": true },
        },
        "codebase-research-locator": {
          tools: { "codegraph*": true, "ast-grep*": true },
        },
        "codebase-research-analyzer": {
          tools: { "codegraph*": true, "ast-grep*": true },
        },
      },
    };

    const filePath = makeTmpOpenCodeJson(config);
    try {
      const errors = lintOpenCodeToolsInvariant(filePath);
      const topLevelErrors = errors.filter((e) => e.includes("top-level tools"));
      expect(topLevelErrors).toHaveLength(2);
      // Each error must include the JSON.stringify'd value "true"
      for (const err of topLevelErrors) {
        expect(err).toContain("true");
      }
    } finally {
      rmSync(filePath, { force: true });
    }
  });

  test("opencode.json with ast-grep* true for codebase-online-researcher reports violation", () => {
    const config = {
      agent: {
        "codebase-online-researcher": {
          tools: {
            "ast-grep*": true,   // WRONG — must be false
            "codegraph*": true,
          },
        },
        "codebase-analyzer": {
          tools: { "codegraph*": true, "ast-grep*": true },
        },
        "codebase-locator": {
          tools: { "codegraph*": true, "ast-grep*": true },
        },
        "codebase-pattern-finder": {
          tools: { "codegraph*": true, "ast-grep*": true },
        },
        "codebase-research-locator": {
          tools: { "codegraph*": true, "ast-grep*": true },
        },
        "codebase-research-analyzer": {
          tools: { "codegraph*": true, "ast-grep*": true },
        },
      },
    };

    const filePath = makeTmpOpenCodeJson(config);
    try {
      const violations = lintOpenCodeToolsInvariant(filePath);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      const combined = violations.join("\n");
      // Must reference online-researcher and ast-grep*
      expect(combined).toContain("codebase-online-researcher");
      expect(combined).toContain("ast-grep*");
    } finally {
      rmSync(filePath, { force: true });
    }
  });
});

// ── §5.7.2 multi-invariant success message ────────────────────────────────────

describe("§5.7.2 multi-invariant success message", () => {
  test("F2: stdout enumerates all 4 invariants on clean run", async () => {
    const scriptPath = join(import.meta.dir, "lint-claude-mcp-allowlist.ts");
    const proc = Bun.spawn(["bun", "run", scriptPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      throw new Error(`script exited ${exitCode}; stderr=${stderr}`);
    }

    // Header + 4 invariants
    expect(stdout).toContain("all 4 invariants pass");
    expect(stdout).toContain("Claude mcpServers");
    expect(stdout).toContain("OpenCode tools toggle");
    expect(stdout).toContain("Forbidden substrings");
    expect(stdout).toContain("Copilot mcp-servers");
  });
});
