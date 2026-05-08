import { test, expect, mock, beforeEach } from "bun:test";
import type { Node, Edge, Subgraph } from "@colbymchenry/codegraph";

// ---------------------------------------------------------------------------
// extractSymbolIds
// ---------------------------------------------------------------------------

// Import after potential mocks so module cache isn't polluted
import { extractSymbolIds } from "./scratch.ts";

test("extractSymbolIds: returns empty array for text with no symbols", () => {
  expect(extractSymbolIds("no symbols here")).toEqual([]);
});

test("extractSymbolIds: extracts single symbol id", () => {
  expect(extractSymbolIds("see [symbol:abc123]")).toEqual(["abc123"]);
});

test("extractSymbolIds: extracts multiple distinct symbol ids", () => {
  const ids = extractSymbolIds(
    "[symbol:aaa] and [symbol:bbb] and [symbol:aaa]",
  );
  expect(ids).toContain("aaa");
  expect(ids).toContain("bbb");
  expect(ids).toHaveLength(2);
});

test("extractSymbolIds: handles dashes and underscores in ids", () => {
  const ids = extractSymbolIds("[symbol:my-symbol_v2]");
  expect(ids).toEqual(["my-symbol_v2"]);
});

// ---------------------------------------------------------------------------
// renderExplorerMarkdown — base sections always present
// ---------------------------------------------------------------------------

function makeMinimalSections(
  overrides: Partial<{
    codegraphHealthy: boolean;
    projectRoot: string;
  }> = {},
) {
  return {
    index: 1,
    total: 3,
    partition: [{ path: "src/foo", fileCount: 5, loc: 1000, files: [] }],
    locatorOutput: "locator text",
    patternsOutput: "patterns text",
    analyzerOutput: "analyzer text",
    onlineOutput: "(no external research applicable)",
    ...overrides,
  };
}

test("renderExplorerMarkdown: base sections present without codegraph", async () => {
  const { renderExplorerMarkdown } = await import("./scratch.ts");
  const md = await renderExplorerMarkdown(makeMinimalSections());
  expect(md).toContain("## Scope");
  expect(md).toContain("## Files in Scope");
  expect(md).toContain("## How It Works");
  expect(md).toContain("## Patterns");
  expect(md).toContain("## Out-of-Partition References");
  // No Callers/Impact when unhealthy
  expect(md).not.toContain("## Callers");
  expect(md).not.toContain("## Impact");
});

test("renderExplorerMarkdown: external references omitted on skip sentinel", async () => {
  const { renderExplorerMarkdown } = await import("./scratch.ts");
  const md = await renderExplorerMarkdown(makeMinimalSections());
  expect(md).not.toContain("## External References");
});

test("renderExplorerMarkdown: external references included when non-empty non-sentinel", async () => {
  const { renderExplorerMarkdown } = await import("./scratch.ts");
  const md = await renderExplorerMarkdown({
    ...makeMinimalSections(),
    onlineOutput: "https://example.com",
  });
  expect(md).toContain("## External References");
});

// ---------------------------------------------------------------------------
// renderExplorerMarkdown — §5.6 healthy branch
// ---------------------------------------------------------------------------

// We mock @colbymchenry/codegraph at the module level so CodeGraph.open
// returns a fake instance with controlled getCallers / getImpactRadius.

const fakeNode = (id: string): Node =>
  ({
    id,
    kind: "function",
    name: id,
    qualifiedName: `src/a.ts::${id}`,
    filePath: "src/a.ts",
    language: "typescript",
    startLine: 1,
    endLine: 10,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
  }) as Node;

const fakeEdge = (source: string, target: string, line?: number): Edge =>
  ({
    source,
    target,
    kind: "calls",
    line,
  }) as Edge;

const fakeSubgraph = (nodeIds: string[]): Subgraph => {
  const nodes = new Map<string, Node>();
  for (const id of nodeIds) nodes.set(id, fakeNode(id));
  return { nodes, edges: [], roots: nodeIds };
};

// Mock the module
mock.module("@colbymchenry/codegraph", () => {
  const getCallersMock = mock(() => [
    { node: fakeNode("callerFn"), edge: fakeEdge("callerFn", "sym1", 42) },
  ]);
  const getImpactRadiusMock = mock(() => fakeSubgraph(["impactedFn"]));
  const closeMock = mock(() => {});

  return {
    CodeGraph: {
      open: mock(async () => ({
        getCallers: getCallersMock,
        getImpactRadius: getImpactRadiusMock,
        close: closeMock,
      })),
    },
  };
});

test("renderExplorerMarkdown: Callers and Impact sections present when healthy and symbols found", async () => {
  const { renderExplorerMarkdown } = await import("./scratch.ts");
  const sections = makeMinimalSections({
    codegraphHealthy: true,
    projectRoot: "/fake/project",
    // Include a symbol reference in analyzer output
  });
  // Inject symbol ref into analyzer output
  const sectionsWithSymbol = {
    ...sections,
    analyzerOutput: "See [symbol:sym1] for details",
  };

  const md = await renderExplorerMarkdown(sectionsWithSymbol);

  expect(md).toContain("## Callers");
  expect(md).toContain("## Impact");
  // Deterministic content from fake graph
  expect(md).toContain("callerFn");
  expect(md).toContain("impactedFn");
});

test("renderExplorerMarkdown: Callers and Impact absent when healthy but no symbol refs", async () => {
  const { renderExplorerMarkdown } = await import("./scratch.ts");
  const sections = makeMinimalSections({
    codegraphHealthy: true,
    projectRoot: "/fake/project",
    // no [symbol:...] tokens in any output
  });

  const md = await renderExplorerMarkdown(sections);

  // No symbols → buildDeterministicGraphSections returns null → no sections
  expect(md).not.toContain("## Callers");
  expect(md).not.toContain("## Impact");
});

test("renderExplorerMarkdown: Callers and Impact absent when codegraphHealthy is false", async () => {
  const { renderExplorerMarkdown } = await import("./scratch.ts");
  const sections = {
    ...makeMinimalSections({ codegraphHealthy: false }),
    analyzerOutput: "See [symbol:sym1] for details",
    projectRoot: "/fake/project",
  };

  const md = await renderExplorerMarkdown(sections);

  expect(md).not.toContain("## Callers");
  expect(md).not.toContain("## Impact");
});

test("renderExplorerMarkdown: Callers and Impact absent when projectRoot missing even if healthy", async () => {
  const { renderExplorerMarkdown } = await import("./scratch.ts");
  const sections = {
    ...makeMinimalSections({ codegraphHealthy: true }),
    // no projectRoot
    analyzerOutput: "See [symbol:sym1] for details",
  };

  const md = await renderExplorerMarkdown(sections);

  expect(md).not.toContain("## Callers");
  expect(md).not.toContain("## Impact");
});
