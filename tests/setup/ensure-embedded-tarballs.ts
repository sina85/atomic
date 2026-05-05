import { existsSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "../../packages/atomic/src/lib/workspace-paths.ts";

const root = findRepoRoot(import.meta.dir);
const requiredTarballs = [
  ".claude.tar",
  ".opencode.tar",
  ".github.tar",
  ".agents/skills.tar",
].map((p) => join(root, p));

if (requiredTarballs.some((p) => !existsSync(p))) {
  const { bundleEmbeddedAssets } = await import(
    "../../packages/atomic/script/build-assets.ts"
  );
  await bundleEmbeddedAssets(root);
}
