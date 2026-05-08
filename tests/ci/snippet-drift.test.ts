import { test } from "bun:test";
import { join } from "node:path";
import {
  generateSnippetsModule,
  OUT_PATH,
  readSources,
} from "../../packages/atomic-sdk/script/build-snippets";

const REPO_ROOT = join(import.meta.dir, "../..");

test("snippets.generated.ts is up-to-date with docs/agent-snippets/*.md", async () => {
  const sources = await readSources(REPO_ROOT);
  const expected = generateSnippetsModule(sources);
  const actual = await Bun.file(join(REPO_ROOT, OUT_PATH)).text();
  if (actual === expected) return;
  throw new Error(
    "snippets.generated.ts is stale. " +
      "Run: bun run --filter @bastani/atomic-sdk build:snippets",
  );
});
