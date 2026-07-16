import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  validatePublishContext,
  verifyProtectedWorkflowAncestry,
  type PublishContext,
} from "../../scripts/verify-publish-context.js";

const protectedSha = "0123456789abcdef0123456789abcdef01234567";
const validContext: PublishContext = {
  eventName: "workflow_run",
  workflowRef: "bastani-inc/atomic/.github/workflows/publish.yml@refs/heads/main",
  workflowSha: protectedSha,
  repository: "bastani-inc/atomic",
  defaultBranch: "main",
  signalEvent: "create",
  signalConclusion: "success",
  signalPath: ".github/workflows/publish-tag-created.yml",
  signalRepository: "bastani-inc/atomic",
};

test("accepts a successful tag-create signal only in a protected default-branch publisher", () => {
  assert.equal(validatePublishContext(validContext), undefined);
});

test("rejects the exact tag-sourced workflow ref observed in failed run 29529182569", () => {
  const context = {
    ...validContext,
    workflowRef: "bastani-inc/atomic/.github/workflows/publish.yml@refs/tags/0.9.10-alpha.1",
    workflowSha: "88c11adcdddcf5245b7b04dd3d2912c7531906fe",
  };
  assert.throws(
    () => validatePublishContext(context),
    /Privileged publish workflow was not loaded from protected main/u,
  );
});

test("rejects aliases, other repositories, and untrusted signal workflows", () => {
  for (const context of [
    { ...validContext, workflowRef: "bastani-inc/atomic/.github/workflows/publish.yml@main" },
    { ...validContext, signalRepository: "attacker/atomic" },
    { ...validContext, signalPath: ".github/workflows/attacker.yml" },
    { ...validContext, signalEvent: "workflow_dispatch" },
    { ...validContext, signalConclusion: "failure" },
  ]) {
    assert.throws(() => validatePublishContext(context));
  }
});

test("rejects missing context and malformed protected workflow SHAs", () => {
  assert.throws(() => validatePublishContext({ ...validContext, workflowRef: undefined }));
  assert.throws(() => validatePublishContext({ ...validContext, workflowSha: "not-a-sha" }));
  assert.throws(() => validatePublishContext({ ...validContext, eventName: undefined }));
});

test("accepts protected ancestors and rejects SHAs outside protected history", () => {
  const revisions = Bun.spawnSync(["git", "rev-parse", "HEAD~1", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(revisions.exitCode, 0, revisions.stderr.toString());
  const [protectedAncestor, protectedTip] = revisions.stdout.toString().trim().split("\n");
  assert.ok(protectedAncestor);
  assert.ok(protectedTip);

  verifyProtectedWorkflowAncestry(protectedAncestor, protectedTip);
  assert.throws(
    () => verifyProtectedWorkflowAncestry("0000000000000000000000000000000000000000", protectedTip),
    /not contained in protected default-branch history/u,
  );
  assert.throws(() => verifyProtectedWorkflowAncestry("malformed", protectedTip), /Invalid protected workflow SHA/u);
});
