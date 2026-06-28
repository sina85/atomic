import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { workflowResumeSelectorItems } from "../../packages/workflows/src/tui/workflow-resume-selector.js";
import type { ResumableWorkflowEntry } from "../../packages/workflows/src/durable/types.js";

function entry(id: string, status: ResumableWorkflowEntry["status"]): ResumableWorkflowEntry {
  return {
    workflowId: id,
    name: `${status}-workflow`,
    status,
    completedCheckpoints: 2,
    pendingPrompts: 0,
    createdAt: 1,
    updatedAt: status === "completed" ? 3 : 2,
  };
}

describe("workflowResumeSelectorItems", () => {
  test("mixes resumable and completed durable entries with distinct selection kinds", () => {
    const items = workflowResumeSelectorItems([], [entry("wf-paused", "paused")], [entry("wf-done", "completed")]);
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((item) => item.result.kind), ["durable", "completed"]);
    assert.match(items[1]!.session.firstMessage, /✓ completed/);
    assert.equal(items[1]!.session.path, "workflow-completed:wf-done");
  });
});
