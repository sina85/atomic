import { test } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import type { WorkflowRegistry } from "../../packages/workflows/src/workflows/registry.js";

function registry(): WorkflowRegistry {
  const def = workflow({
    name: "resumable-pipeline",
    description: "",
    inputs: { topic: Type.String() },
    outputs: { done: Type.Optional(Type.Boolean()) },
    run: async () => ({ done: true }),
  }) as unknown as WorkflowDefinition;
  const value: WorkflowRegistry = {
    register: () => value,
    merge: () => value,
    get: (name) => name === def.name || name === def.normalizedName ? def : undefined,
    has: (name) => name === def.name || name === def.normalizedName,
    remove: () => value,
    names: () => [def.normalizedName],
    all: () => [def],
  };
  return value;
}

function deps(backend: InMemoryDurableBackend, store = createStore()) {
  return {
    store,
    input: {
      registry: registry(),
      baseRunOpts: { store, cancellation: createCancellationRegistry(), jobs: createJobTracker() },
      durableBackend: backend,
    },
  };
}

test("resume revalidates a stale picker row against the authoritative terminal handle", async () => {
  const backend = new InMemoryDurableBackend();
  const { store, input } = deps(backend);
  backend.registerWorkflow({ workflowId: "wf-picker-race", name: "resumable-pipeline", inputs: { topic: "a" }, createdAt: 1, status: "completed", completedCheckpoints: 1 });
  const staleCatalog = [{ workflowId: "wf-picker-race", name: "resumable-pipeline", status: "paused" as const, completedCheckpoints: 1, pendingPrompts: 0, createdAt: 1, updatedAt: 2 }];
  const result = await resumeDurableWorkflow("wf-picker-race", input, staleCatalog);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "not_resumable");
  assert.equal(store.runs().some((run) => run.id === "wf-picker-race"), false);
});

test("a restored running snapshot with a free execution lease resumes instead of being refused", async () => {
  class LeaseBackend extends InMemoryDurableBackend {
    leaseActive = false;
    isWorkflowExecutionActive(): boolean { return this.leaseActive; }
  }
  const backend = new LeaseBackend();
  const { store, input } = deps(backend);
  backend.registerWorkflow({ workflowId: "wf-ctrlc-ghost", name: "resumable-pipeline", inputs: { topic: "a" }, createdAt: 1, status: "running", completedCheckpoints: 1 });
  // Exact-session restoration reconstructs a `running` store snapshot even
  // though the crashed process released nothing gracefully; the execution
  // lease is free (leaseActive=false).
  store.recordRunStart({ id: "wf-ctrlc-ghost", name: "resumable-pipeline", inputs: {}, status: "running", stages: [], startedAt: 1 });
  const result = await resumeDurableWorkflow("wf-ctrlc-ghost", input);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.runId, "wf-ctrlc-ghost");
  // The ghost snapshot must not be duplicated by re-dispatch.
  assert.equal(store.runs().filter((run) => run.id === "wf-ctrlc-ghost").length, 1);
});

test("an actively-leased running workflow is still refused as already running", async () => {
  class LeaseBackend extends InMemoryDurableBackend {
    isWorkflowExecutionActive(): boolean { return true; }
  }
  const backend = new LeaseBackend();
  const { input } = deps(backend);
  backend.registerWorkflow({ workflowId: "wf-live-owned", name: "resumable-pipeline", inputs: { topic: "a" }, createdAt: 1, status: "running", completedCheckpoints: 1 });
  const result = await resumeDurableWorkflow("wf-live-owned", input);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "not_resumable");
    assert.match(result.message, /already running/);
  }
});

test("resume fails synchronously and restores state when detached setup is not published", async () => {
  class FailingBackend extends InMemoryDurableBackend {
    failRegistration = false;
    override registerWorkflow(handle: Parameters<InMemoryDurableBackend["registerWorkflow"]>[0]): void {
      if (this.failRegistration) throw new Error("injected resume registration failure");
      super.registerWorkflow(handle);
    }
  }
  const backend = new FailingBackend();
  const { store, input } = deps(backend);
  backend.registerWorkflow({ workflowId: "wf-setup-reject", name: "resumable-pipeline", inputs: { topic: "a" }, createdAt: 1, status: "paused", completedCheckpoints: 1 });
  backend.failRegistration = true;
  await assert.rejects(() => resumeDurableWorkflow("wf-setup-reject", input), /injected resume registration failure/);
  assert.equal(backend.getWorkflow("wf-setup-reject")?.status, "paused");
  assert.equal(store.runs().some((run) => run.id === "wf-setup-reject"), false);
});

test("async durable startup failure is reported and cannot strand ownership", async () => {
  class AsyncFailingBackend extends InMemoryDurableBackend {
    claimed = false;
    claimWorkflowExecution(): boolean { this.claimed = true; return true; }
    releaseWorkflowExecution(): void { this.claimed = false; }
    async flush(): Promise<void> { throw new Error("injected DBOS async write failure"); }
  }
  const backend = new AsyncFailingBackend();
  const { store, input } = deps(backend);
  backend.registerWorkflow({ workflowId: "wf-async-reject", name: "resumable-pipeline", inputs: { topic: "a" }, createdAt: 1, status: "paused", completedCheckpoints: 1 });
  await assert.rejects(() => resumeDurableWorkflow("wf-async-reject", input), /injected DBOS async write failure/);
  assert.equal(backend.getWorkflow("wf-async-reject")?.status, "paused");
  assert.equal(backend.claimed, false);
  assert.equal(store.runs().some((run) => run.id === "wf-async-reject"), false);
});
