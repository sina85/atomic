/**
 * Emit the gitignored tarballs that
 * `packages/atomic/src/lib/embedded-assets.ts` imports via
 * `with { type: "file" }` so `bun run dev` works on a fresh checkout.
 *
 * Idempotent: skips emission when every required artifact is already
 * present, mirroring `tests/setup/ensure-embedded-tarballs.ts`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "../src/lib/workspace-paths.ts";
import { bundleEmbeddedAssets } from "./build-assets.ts";

const root = findRepoRoot(import.meta.dir);

const requiredTarballs = [
  ".claude.tar",
  ".opencode.tar",
  ".github.tar",
  ".agents/skills.tar",
].map((p) => join(root, p));

const tarballsMissing = requiredTarballs.some((p) => !existsSync(p));
if (tarballsMissing) await bundleEmbeddedAssets(root);
