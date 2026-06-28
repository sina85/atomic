// @ts-nocheck
import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { handleRunControlCommand } from "../../packages/workflows/src/extension/workflow-run-control-command.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { store } from "../../packages/workflows/src/shared/store.js";

function runtimeStub(onResume: () => void) {
  return {
    registry: { has: () => false },
    dispatch: async () => ({}),
    runDirect: async () => ({}),
    resumeFailedRun: () => ({ ok: false, reason: "run_not_found", message: "no" }),
    resumeDurableWorkflow: () => {
      onResume();
      return { ok: false, reason: "not_resumable", message: "should not resume" };
    },
    listDurableResumable: () => [],
    prepareDurableResumable: async () => [],
  };
}

describe("/workflow resume completed durable target", () => {
  afterEach(() => {
    setDurableBackend(undefined);
    store.clear();
  });

  test("opens a completed durable snapshot without re-dispatching resume", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    backend.registerWorkflow({ workflowId: "wf-done-command", name: "completed-flow", inputs: {}, createdAt: 1, status: "completed", completedCheckpoints: 1 });
    backend.recordCheckpoint({ kind: "stage", workflowId: "wf-done-command", checkpointId: "stage:1", name: "final", replayKey: "stage:final:1", output: "ok", completedAt: 2 });

    let resumeCalled = false;
    const opened: string[] = [];
    const messages: string[] = [];
    const handled = await handleRunControlCommand("resume", ["wf-done"], { ui: {} }, {
      info: (message: string) => messages.push(message),
      error: (message: string) => messages.push(message),
    }, {
      pi: {},
      overlay: { open: (runId: string) => opened.push(runId), toggle: () => undefined, close: () => undefined },
      getPersistence: () => undefined,
      runtimeForContext: () => runtimeStub(() => { resumeCalled = true; }),
    });

    assert.equal(handled, true);
    assert.equal(resumeCalled, false);
    assert.deepEqual(opened, ["wf-done-command"]);
    assert.match(messages.join("\n"), /Opened completed durable workflow/);
    assert.equal(store.runs()[0]!.status, "completed");
  });
});
