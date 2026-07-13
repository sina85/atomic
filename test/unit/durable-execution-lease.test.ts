import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryDurableBackend, workflowDefinitionHash } from "../../packages/workflows/src/durable/backend.js";
import { WorkflowFileDurableBackend, durableStateFileFor } from "../../packages/workflows/src/durable/file-backend.js";
import { activeHeartbeatCountForTests } from "../../packages/workflows/src/durable/execution-lease.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { assert as exAssert, createStore, run, Type, workflow } from "./executor-shared.js";

function checkpoint(workflowId: string): DurableCheckpoint {
  return { kind: "tool", workflowId, checkpointId: "cp-ready", name: "ready", argsHash: "hash-ready", output: "ready", completedAt: 2 };
}

describe("durable execution ownership", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "durable-execution-lease-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("encodes Windows-illegal workflow id characters in durable filenames", () => {
    const workflowId = "wf:*?<>|\\/quoted\"";
    const filePath = durableStateFileFor(dir, workflowId);
    assert.equal(filePath.includes("*"), false);
    const backend = new WorkflowFileDurableBackend(dir);
    backend.registerWorkflow({ workflowId, name: "portable", inputs: {}, createdAt: 1, status: "paused" });
    assert.equal(existsSync(filePath), true);
  });

  test("getWorkflow reads fresh from disk so an externally pruned root is not resurrected", () => {
    const workflowId = "wf-pruned-root";
    const owner = new WorkflowFileDurableBackend(dir);
    const observer = new WorkflowFileDurableBackend(dir);
    owner.registerWorkflow({ workflowId, name: "prunable", inputs: {}, createdAt: 1, status: "paused", completedCheckpoints: 1 });
    // The observer caches a `paused` handle snapshot.
    assert.equal(observer.getWorkflow(workflowId)?.status, "paused");
    // The owner completes and prunes the state file.
    owner.setWorkflowStatus(workflowId, "completed");
    assert.equal(existsSync(durableStateFileFor(dir, workflowId)), false);
    // The observer must not keep serving the stale cached paused handle.
    assert.equal(observer.getWorkflow(workflowId), undefined);
    assert.equal(observer.listResumableWorkflows().some((entry) => entry.workflowId === workflowId), false);
  });

  test("reset clears the in-memory execution claim so the lease can be re-claimed", () => {
    const backend = new WorkflowFileDurableBackend(dir);
    backend.registerWorkflow({ workflowId: "wf-reset-claim", name: "reset", inputs: {}, createdAt: 1, status: "running" });
    assert.equal(backend.claimWorkflowExecution("wf-reset-claim"), true);
    backend.reset();
    assert.equal(backend.claimWorkflowExecution("wf-reset-claim"), true);
  });

  test("a confirmed-live PID with unconfirmable identity is pinned, not evicted on a stale heartbeat", () => {
    const workflowId = "wf-live-unconfirmable";
    const stateFile = durableStateFileFor(dir, workflowId);
    const seed = new WorkflowFileDurableBackend(dir);
    seed.registerWorkflow({ workflowId, name: "live", inputs: {}, createdAt: 1, status: "running" });
    seed.recordCheckpoint(checkpoint(workflowId));
    const leaseDir = `${stateFile}.active`;
    mkdirSync(leaseDir, { mode: 0o700 });
    // Owner records the CURRENT (alive) pid but no saved process identity, so
    // liveness cannot be disambiguated from PID reuse. Because the pid is
    // confirmed alive, a stale heartbeat must NOT evict it (a long synchronous
    // stage can stall the heartbeat while the owner still runs); reclaiming
    // would double-dispatch.
    const ownerFile = `${leaseDir}/owner.json`;
    writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, host: hostname(), token: "live-no-identity", acquiredAt: 1 }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(ownerFile, old, old);
    assert.equal(new WorkflowFileDurableBackend(dir).claimWorkflowExecution(workflowId), false);
  });

  test("paused metadata remains owned until the executor actually stops", () => {
    const owner = new WorkflowFileDurableBackend(dir);
    const contender = new WorkflowFileDurableBackend(dir);
    owner.registerWorkflow({ workflowId: "wf-active", name: "active", inputs: {}, createdAt: 1, status: "running" });
    owner.recordCheckpoint(checkpoint("wf-active"));

    assert.equal(owner.claimWorkflowExecution("wf-active"), true);
    owner.setWorkflowStatus("wf-active", "paused", undefined, true);
    assert.equal(contender.listResumableWorkflows().some((entry) => entry.workflowId === "wf-active"), false);
    assert.equal(contender.claimWorkflowExecution("wf-active"), false);

    owner.releaseWorkflowExecution("wf-active");
    assert.equal(contender.listResumableWorkflows().some((entry) => entry.workflowId === "wf-active"), true);
    assert.equal(contender.claimWorkflowExecution("wf-active"), true);
  });

  test("one backend cannot dispatch the same workflow id twice concurrently", async () => {
    const backend = new WorkflowFileDurableBackend(dir);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let executions = 0;
    const def = workflow({
      name: "single-dispatch",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async (ctx) => {
        executions += 1;
        await gate;
        await ctx.stage("done").complete("done");
        return { result: "done" };
      },
    });
    const opts = { runId: "wf-single-dispatch", store: createStore(), durableBackend: backend, adapters: { complete: { complete: async (text: string) => text } } };
    const first = run(def, {}, opts);
    await Promise.resolve();
    await assert.rejects(
      () => run(def, {}, { ...opts, store: createStore() }),
      /already running in another Atomic process/,
    );
    assert.equal(executions, 1);
    release();
    assert.equal((await first).status, "completed");
  });

  test("a cancellation during the resume publication flush aborts before workflow code runs", async () => {
    const controller = new AbortController();
    let ran = 0;
    class AbortingFlushBackend extends InMemoryDurableBackend {
      claimWorkflowExecution(): boolean { return true; }
      releaseWorkflowExecution(): void {}
      async flush(): Promise<void> { controller.abort(); }
    }
    const def = workflow({
      name: "ctrlc-publish",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async () => { ran += 1; return { result: "must-not-run" }; },
    });
    const result = await run(def, {}, {
      runId: "wf-ctrlc-publish",
      store: createStore(),
      durableBackend: new AbortingFlushBackend(),
      signal: controller.signal,
      durableExecutionClaimed: true,
      deferWorkflowStart: false,
    });
    // Cancellation during the durable startup flush must abort before def.run.
    assert.equal(ran, 0);
    assert.notEqual(result.status, "completed");
  });

  test("a hard-crashed execution owner is immediately reclaimable", async () => {
    const workflowId = "wf-crashed-owner";
    const stateFile = durableStateFileFor(dir, workflowId);
    const seed = new WorkflowFileDurableBackend(dir);
    seed.registerWorkflow({ workflowId, name: "crashed", inputs: {}, createdAt: 1, status: "running" });
    seed.recordCheckpoint(checkpoint(workflowId));
    const modulePath = join(process.cwd(), "packages/workflows/src/durable/file-backend.ts");
    const child = Bun.spawn([
      "bun",
      "-e",
      `import { WorkflowFileDurableBackend } from ${JSON.stringify(modulePath)}; const backend = new WorkflowFileDurableBackend(process.argv[1]); if (!backend.claimWorkflowExecution(${JSON.stringify(workflowId)})) process.exit(2); setInterval(() => {}, 1000);`,
      dir,
    ], { stdout: "ignore", stderr: "inherit" });

    try {
      for (let attempt = 0; attempt < 100 && !existsSync(`${stateFile}.active`); attempt++) await Bun.sleep(10);
      assert.equal(existsSync(`${stateFile}.active`), true);
      const contender = new WorkflowFileDurableBackend(dir);
      assert.equal(contender.listResumableWorkflows().some((entry) => entry.workflowId === workflowId), false);
      child.kill("SIGKILL");
      await child.exited;
      assert.equal(contender.listResumableWorkflows().some((entry) => entry.workflowId === workflowId), true);
      assert.equal(contender.claimWorkflowExecution(workflowId), true);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  });

  test("an ownerless lease directory from an interrupted claim is reclaimed", () => {
    const workflowId = "wf-ownerless-claim";
    const stateFile = durableStateFileFor(dir, workflowId);
    const seed = new WorkflowFileDurableBackend(dir);
    seed.registerWorkflow({ workflowId, name: "ownerless", inputs: {}, createdAt: 1, status: "running" });
    seed.recordCheckpoint(checkpoint(workflowId));
    mkdirSync(`${stateFile}.active`, { mode: 0o700 });

    const recovered = new WorkflowFileDurableBackend(dir);
    assert.equal(recovered.listResumableWorkflows().some((entry) => entry.workflowId === workflowId), true);
    assert.equal(recovered.claimWorkflowExecution(workflowId), true);
  });

  test("stale malformed and reused-PID leases are reclaimed", () => {
    const cases = [
      "{malformed",
      JSON.stringify({ pid: process.pid, host: hostname(), token: "reused", acquiredAt: 1, processIdentity: "different-process-start" }),
    ];
    for (const [index, owner] of cases.entries()) {
      const workflowId = `wf-stale-lease-${index}`;
      const stateFile = durableStateFileFor(dir, workflowId);
      const seed = new WorkflowFileDurableBackend(dir);
      seed.registerWorkflow({ workflowId, name: "stale", inputs: {}, createdAt: 1, status: "running" });
      seed.recordCheckpoint(checkpoint(workflowId));
      const leaseDir = `${stateFile}.active`;
      mkdirSync(leaseDir, { mode: 0o700 });
      const ownerFile = `${leaseDir}/owner.json`;
      writeFileSync(ownerFile, owner);
      const old = new Date(Date.now() - 60_000);
      utimesSync(ownerFile, old, old);
      assert.equal(new WorkflowFileDurableBackend(dir).claimWorkflowExecution(workflowId), true);
    }
  });

  test("a foreign-host execution lease is conservatively pinned to prevent cross-host double-dispatch", () => {
    // File durability is a same-host store; cross-host coordination must use the
    // DBOS/PostgreSQL backend. A foreign-host lease is never heartbeat-reclaimed
    // here, since a stale heartbeat could reflect a long synchronous stage on a
    // still-live owner rather than a dead one.
    const workflowId = "wf-foreign-host-pinned";
    const stateFile = durableStateFileFor(dir, workflowId);
    const seed = new WorkflowFileDurableBackend(dir);
    seed.registerWorkflow({ workflowId, name: "foreign", inputs: {}, createdAt: 1, status: "running" });
    seed.recordCheckpoint(checkpoint(workflowId));
    const leaseDir = `${stateFile}.active`;
    mkdirSync(leaseDir, { mode: 0o700 });
    const ownerFile = `${leaseDir}/owner.json`;
    writeFileSync(ownerFile, JSON.stringify({ pid: 1, host: "another-host.example", token: "foreign", acquiredAt: 1 }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(ownerFile, old, old);
    assert.equal(new WorkflowFileDurableBackend(dir).claimWorkflowExecution(workflowId), false);
  });

  test("a completed workflow does not leak its execution-lease heartbeat", () => {
    const before = activeHeartbeatCountForTests();
    const backend = new WorkflowFileDurableBackend(dir);
    backend.registerWorkflow({ workflowId: "wf-heartbeat-leak", name: "leak", inputs: {}, createdAt: 1, status: "running" });
    assert.equal(backend.claimWorkflowExecution("wf-heartbeat-leak"), true);
    assert.equal(activeHeartbeatCountForTests(), before + 1);
    // Terminal completion prunes the lease directory; the heartbeat must stop.
    backend.setWorkflowStatus("wf-heartbeat-leak", "completed");
    assert.equal(activeHeartbeatCountForTests(), before);
  });

  test("an old heartbeat cannot evict a live same-host owner", () => {
    const workflowId = "wf-live-suspended-owner";
    const stateFile = durableStateFileFor(dir, workflowId);
    const owner = new WorkflowFileDurableBackend(dir);
    owner.registerWorkflow({ workflowId, name: "live", inputs: {}, createdAt: 1, status: "running" });
    assert.equal(owner.claimWorkflowExecution(workflowId), true);
    const ownerFile = `${stateFile}.active/owner.json`;
    const old = new Date(Date.now() - 60_000);
    utimesSync(ownerFile, old, old);
    assert.equal(new WorkflowFileDurableBackend(dir).claimWorkflowExecution(workflowId), false);
  });

  test("stale ownerless and dead-process state locks are recoverable", () => {
    const workflowId = "wf-stale-state-lock";
    const stateFile = durableStateFileFor(dir, workflowId);
    const seed = new WorkflowFileDurableBackend(dir);
    seed.registerWorkflow({ workflowId, name: "stale-lock", inputs: {}, createdAt: 1, status: "paused" });
    seed.recordCheckpoint(checkpoint(workflowId));

    const lockDir = `${stateFile}.lock`;
    mkdirSync(lockDir, { mode: 0o700 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockDir, old, old);
    assert.equal(new WorkflowFileDurableBackend(dir).listResumableWorkflows().length, 1);

    mkdirSync(lockDir, { mode: 0o700 });
    writeFileSync(`${lockDir}/owner.json`, JSON.stringify({
      pid: 2_147_483_647,
      host: hostname(),
      token: "dead-stale-owner",
      acquiredAt: Date.now() - 60_000,
    }));
    utimesSync(lockDir, old, old);
    assert.equal(new WorkflowFileDurableBackend(dir).listResumableWorkflows().length, 1);
  });

  test("a refused claim cannot mutate the active durable handle", async () => {
    class RefusingBackend extends InMemoryDurableBackend {
      claimWorkflowExecution(): boolean {
        return false;
      }
    }
    const backend = new RefusingBackend();
    const store = createStore();
    let starts = 0;
    const def = workflow({
      name: "refused-claim",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async () => ({ result: "must-not-run" }),
    });

    await assert.rejects(() => run(def, {}, {
      runId: "wf-refused-claim",
      store,
      durableBackend: backend,
      onRunStart: () => { starts += 1; },
    }), /already running in another Atomic process/);

    assert.equal(backend.getWorkflow("wf-refused-claim"), undefined);
    assert.equal(store.runs().length, 0);
    assert.equal(starts, 0);
  });

  test("a setup failure after claiming releases ownership and removes the store snapshot", async () => {
    const workflowId = "wf-setup-failure";
    const owner = new WorkflowFileDurableBackend(dir);
    const store = createStore();
    const def = workflow({
      name: "setup-failure",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async () => ({ result: "must-not-run" }),
    });

    await assert.rejects(() => run(def, {}, {
      runId: workflowId,
      store,
      durableBackend: owner,
      onRunStart: () => { throw new Error("injected setup failure"); },
    }), /injected setup failure/);

    assert.equal(store.runs().length, 0);
    assert.equal(new WorkflowFileDurableBackend(dir).claimWorkflowExecution(workflowId), true);
  });

  test("a durable registration failure cannot strand execution ownership", async () => {
    class FailingRegistrationBackend extends InMemoryDurableBackend {
      claimed = false;
      claimWorkflowExecution(): boolean {
        if (this.claimed) return false;
        this.claimed = true;
        return true;
      }
      releaseWorkflowExecution(): void {
        this.claimed = false;
      }
      override registerWorkflow(_handle: Parameters<InMemoryDurableBackend["registerWorkflow"]>[0]): void {
        throw new Error("injected durable registration failure");
      }
    }
    const backend = new FailingRegistrationBackend();
    const def = workflow({
      name: "registration-failure",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async (ctx) => {
        await ctx.stage("must-not-run").complete("done");
        return { result: "must-not-run" };
      },
    });

    const result = await run(def, {}, {
      runId: "wf-registration-failure",
      store: createStore(),
      durableBackend: backend,
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /injected durable registration failure/);
    assert.equal(backend.claimed, false);
  });

  test("a throwing lease release cannot skip cancellation cleanup", async () => {
    class ThrowingReleaseBackend extends InMemoryDurableBackend {
      claimWorkflowExecution(): boolean { return true; }
      releaseWorkflowExecution(): void { throw new Error("injected release failure"); }
    }
    const cancellation = createCancellationRegistry();
    const def = workflow({
      name: "release-failure",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async (ctx) => {
        await ctx.stage("done").complete("done");
        return { result: "done" };
      },
    });

    await assert.rejects(() => run(def, {}, {
      runId: "wf-release-failure",
      store: createStore(),
      durableBackend: new ThrowingReleaseBackend(),
      cancellation,
    }), /injected release failure/);
    assert.equal(cancellation.abort("wf-release-failure"), false);
  });

  test("one backend token cannot re-enter the same workflow through two dispatches", async () => {
    const backend = new WorkflowFileDurableBackend(dir);
    let executions = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const def = workflow({
      name: "single-dispatch",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async (ctx) => {
        executions += 1;
        await gate;
        await ctx.stage("done").complete("done");
        return { result: "done" };
      },
    });
    const adapters = { complete: { complete: async (text: string) => text } };
    const first = run(def, {}, { runId: "wf-single-dispatch", store: createStore(), durableBackend: backend, adapters });
    await assert.rejects(
      () => run(def, {}, { runId: "wf-single-dispatch", store: createStore(), durableBackend: backend, adapters }),
      /already running in another Atomic process/,
    );
    assert.equal(executions, 1);
    release();
    const firstResult = await first;
    assert.equal(firstResult.status, "completed", JSON.stringify(firstResult));
  });

  test("resumable roots are deterministic newest-first with an id tie-break", () => {
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "wf-newer", name: "newer", inputs: {}, createdAt: 2, updatedAt: 20, status: "paused", completedCheckpoints: 1 });
    backend.registerWorkflow({ workflowId: "wf-older", name: "older", inputs: {}, createdAt: 1, updatedAt: 10, status: "paused", completedCheckpoints: 1 });
    backend.registerWorkflow({ workflowId: "wf-tie-b", name: "tie-b", inputs: {}, createdAt: 3, updatedAt: 15, status: "paused", completedCheckpoints: 1 });
    backend.registerWorkflow({ workflowId: "wf-tie-a", name: "tie-a", inputs: {}, createdAt: 3, updatedAt: 15, status: "paused", completedCheckpoints: 1 });

    assert.deepEqual(backend.listResumableWorkflows().map((entry) => entry.workflowId), ["wf-newer", "wf-tie-a", "wf-tie-b", "wf-older"]);
  });

  test("definition hashes change when authored workflow code changes", () => {
    const v1 = workflow({
      name: "versioned-definition",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async () => ({ result: "version-one" }),
    });
    const v2 = workflow({
      name: "versioned-definition",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async () => ({ result: "version-two" }),
    });

    assert.notEqual(workflowDefinitionHash(v1), workflowDefinitionHash(v2));
  });

  test("top-level execution claims ownership before workflow code runs", async () => {
    class TrackingBackend extends InMemoryDurableBackend {
      claims: string[] = [];
      claimWorkflowExecution(workflowId: string): boolean {
        this.claims.push(workflowId);
        return true;
      }
    }
    const backend = new TrackingBackend();
    const def = workflow({
      name: "claim-before-run",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async (ctx) => {
        exAssert.deepEqual(backend.claims, ["wf-claim-before-run"]);
        await ctx.stage("one").complete("done");
        return { result: "ok" };
      },
    });

    const result = await run(def, {}, {
      runId: "wf-claim-before-run",
      store: createStore(),
      durableBackend: backend,
      adapters: { complete: { complete: async (text) => text } },
    });

    exAssert.equal(result.status, "completed");
    exAssert.deepEqual(backend.claims, ["wf-claim-before-run"]);
    exAssert.equal(backend.getWorkflow("wf-claim-before-run")?.definitionHash, workflowDefinitionHash(def));
  });
});
