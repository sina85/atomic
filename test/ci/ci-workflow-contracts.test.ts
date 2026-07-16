import { test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("test workflow runs platform-independent suites once and preserves cross-platform smoke", async () => {
  const workflow = await Bun.file(join(root, ".github/workflows/test.yml")).text();
  for (const step of ["Typecheck", "File length check", "Docs link validation"]) {
    const block = workflow.slice(workflow.indexOf(`- name: ${step}`), workflow.indexOf("- name:", workflow.indexOf(`- name: ${step}`) + 1));
    assert.match(block, /if: runner\.os == 'Linux'/, `${step} must run on only one matrix leg`);
  }
  assert.match(workflow, /ATOMIC_REQUIRE_INSTALLED_NODE_SMOKE: "1"/);
  assert.match(workflow, /--skip-install --skip-package-build --platform/);
  assert.match(workflow, /Smoke test Linux release archive/);
  assert.match(workflow, /Smoke test Windows release archive/);
  assert.match(workflow, /run-flaky-test-suite\.ts --label "unit tests/);
  assert.match(workflow, /name: Deterministic CI and release contracts[\s\S]*run: bun run test:ci-contracts/);
  const deterministicBlock = workflow.slice(workflow.indexOf("name: Deterministic CI and release contracts"), workflow.indexOf("name: Unit tests"));
  assert.doesNotMatch(deterministicBlock, /run-flaky-test-suite/);
  assert.match(workflow, /run-flaky-test-suite\.ts --label "integration tests/);
  assert.match(workflow, /run-flaky-test-suite\.ts --label "coding-agent tests/);
  assert.match(workflow, /name: Upload flaky-test diagnostics[\s\S]*if: always\(\)/);
});

test("tag creation is unprivileged and protected publication is selected separately", async () => {
  const signal = await Bun.file(join(root, ".github/workflows/publish-tag-created.yml")).text();
  const publish = await Bun.file(join(root, ".github/workflows/publish.yml")).text();

  assert.match(signal, /on:\n\s+create:/u);
  assert.match(signal, /permissions: \{\}/u);
  assert.match(signal, /if \[\[ "\$REF_TYPE" != "tag" \]\]; then[\s\S]*exit 1/u);
  assert.doesNotMatch(signal, /checkout|id-token|npm publish|action-gh-release/u);
  assert.match(signal, /WORKFLOW_REF: \$\{\{ github\.workflow_ref \}\}/u);
  assert.doesNotMatch(signal, /refs\/heads\/main/u);

  assert.match(publish, /workflow_run:\n\s+workflows: \["Publish tag created"\]\n\s+types: \[completed\]/u);
  assert.doesNotMatch(publish, /\n\s+create:/u);
  assert.match(publish, /ref: \$\{\{ github\.workflow_sha \}\}/u);
  assert.match(publish, /RELEASE_TAG: \$\{\{ github\.event\.workflow_run\.head_branch \}\}/u);
  assert.match(publish, /TRIGGER_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/u);
  assert.match(publish, /bun scripts\/verify-publish-context\.ts/u);
  assert.match(publish, /PROTECTED_DEFAULT_REF: refs\/remotes\/atomic-publisher\/protected-default/u);
  assert.match(publish, /environment: npm-publish/u);
});

test("protected publisher retains release and OIDC integrity gates", async () => {
  const publish = await Bun.file(join(root, ".github/workflows/publish.yml")).text();
  for (const invariant of [
    '[[ "$release_sha" == "$TRIGGER_SHA" ]]',
    "Release-base-ref",
    "Release-base-sha",
    'git merge-base --is-ancestor "$release_base_sha" "$fetched_base_sha"',
    "scripts/verify-release-integrity.ts",
    "persist-credentials: false",
    "id-token: write",
    "npm publish --provenance",
    "Reconfirm release tag is immutable",
  ]) {
    assert.ok(publish.includes(invariant), `missing release invariant: ${invariant}`);
  }
});

test("recovery guidance rejects recreating the unpublished tag at its old commit", async () => {
  const docs = await Bun.file(join(root, "docs/ci.md")).text();
  assert.match(docs, /preferred recovery[\s\S]*0\.9\.10-alpha\.2[\s\S]*post-merge protected `main`/u);
  assert.match(
    docs,
    /Recreating `0\.9\.10-alpha\.1` at its existing commit `88c11adcdddcf5245b7b04dd3d2912c7531906fe` is insufficient/u,
  );
  assert.match(docs, /new deterministic `Release 0\.9\.10-alpha\.1` commit whose parent is post-merge protected `main`/u);
});
