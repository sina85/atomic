import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DbosDurableBackend, dbosLeaseNamespace, type DbosSdkHandle, type DbosWorkflowInfo } from "../../packages/workflows/src/durable/dbos-backend.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";

function mockSdk(): DbosSdkHandle {
  const workflows = new Map<string, DbosWorkflowInfo>();
  const steps = new Map<string, WorkflowSerializableValue>();
  return {
    async launch() {},
    async shutdown() {},
    async startWorkflow(workflowId, name, inputs) {
      workflows.set(workflowId, { workflowId, name, inputs, status: "PENDING", createdAt: Date.now() });
    },
    async retrieveWorkflow(workflowId) { return workflows.get(workflowId); },
    async cancelWorkflow() {},
    async resumeWorkflow() {},
    async listAllWorkflows() { return [...workflows.values()]; },
    async listStepRecords(workflowId) {
      const prefix = `${workflowId}:`;
      return [...steps].filter(([key]) => key.startsWith(prefix)).map(([key, output]) => ({ stepName: key.slice(prefix.length), output }));
    },
    async recordStepOutput(workflowId, stepName, output) { steps.set(`${workflowId}:${stepName}`, output); },
  };
}

test("DBOS lease namespaces canonicalize same-database URLs without credentials", () => {
  assert.equal(
    dbosLeaseNamespace("postgres://alice:one@DB.EXAMPLE/app?sslmode=require"),
    dbosLeaseNamespace("postgresql://bob:two@db.example:5432/app"),
  );
  assert.notEqual(dbosLeaseNamespace("postgres://db.example/app"), dbosLeaseNamespace("postgres://db.example/other"));
});

test("DBOS backend fails loudly rather than disabling execution exclusion without a lease directory", () => {
  const backend = new DbosDurableBackend(mockSdk());
  assert.throws(() => backend.claimWorkflowExecution("wf-no-lease-dir"), /require a shared lease directory/);
});

test("DBOS backends share duplicate-dispatch execution leases", async () => {
  const leaseDir = mkdtempSync(join(tmpdir(), "dbos-execution-lease-"));
  try {
    const sdk = mockSdk();
    const owner = new DbosDurableBackend(sdk, leaseDir);
    const contender = new DbosDurableBackend(sdk, leaseDir);
    owner.registerWorkflow({ workflowId: "wf-dbos-owned", name: "owned", inputs: {}, createdAt: 1, status: "running" });
    owner.recordCheckpoint({ kind: "tool", workflowId: "wf-dbos-owned", checkpointId: "ready", name: "ready", argsHash: "h-ready", output: "ready", completedAt: 2 });
    await owner.flush();
    await contender.hydrateWorkflow("wf-dbos-owned");

    assert.equal(owner.claimWorkflowExecution("wf-dbos-owned"), true);
    assert.equal(contender.claimWorkflowExecution("wf-dbos-owned"), false);
    assert.equal(contender.listResumableWorkflows().some((entry) => entry.workflowId === "wf-dbos-owned"), false);

    owner.setWorkflowStatus("wf-dbos-owned", "paused", undefined, true);
    await owner.flush();
    assert.equal(contender.claimWorkflowExecution("wf-dbos-owned"), false);
    owner.releaseWorkflowExecution("wf-dbos-owned");
    assert.equal(contender.claimWorkflowExecution("wf-dbos-owned"), true);
  } finally {
    rmSync(leaseDir, { recursive: true, force: true });
  }
});
