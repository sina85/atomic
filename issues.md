# issues.md

## Q-new-1: scout.ts CodeGraph API deviation

**File:** `packages/atomic-sdk/src/workflows/builtin/deep-research-codebase/helpers/scout.ts`

**Issue:** The spec (RFC §5.5) references `cg.listFiles()` as the CodeGraph API to call when the graph is healthy. However, `@colbymchenry/codegraph@0.7.3` does **not** expose a `listFiles()` method. The actual API is `cg.getFiles()` which returns `FileRecord[]`.

**Fallback used:** `opts.graph.getFiles()` — returns all tracked `FileRecord` objects.

**Additional deviation:** `FileRecord` has no `lineCount` property (fields are: `path`, `contentHash`, `language`, `size`, `modifiedAt`, `indexedAt`, `nodeCount`, `errors`). The `loc` field in `SourceFile` is therefore set to `0` for all CodeGraph-indexed files. Downstream bin-packing balances on file counts when LOC is uniform, so partitioning still works.

**Status:** Logged; using `getFiles()` with `loc: 0`.
