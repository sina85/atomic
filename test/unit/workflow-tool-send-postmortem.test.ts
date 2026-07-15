/**
 * Unit tests for `workflow send` post-mortem parity.
 *
 * Verifies:
 *  - a registry miss + valid retained session revives the stage and delivers
 *    the text as a conversational follow-up (not execution resume);
 *  - an invalid/missing retained session stays a no-op with an explicit reason;
 *  - run/stage status is unchanged by a post-mortem follow-up.
 *
 * cross-ref: src/extension/workflow-tool-send.ts, src/runs/foreground/postmortem-stage-chat.ts
 */
import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workflowSendAction } from "../../packages/workflows/src/extension/workflow-tool-send.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { PostMortemStageChatDeps } from "../../packages/workflows/src/runs/foreground/postmortem-stage-chat.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { mockSession, type StageSessionRuntime } from "./executor-shared.js";

let tempDir = "";
const RUN_ID = "postmortem-send-run";

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "atomic-send-postmortem-")); });
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  store.removeRun(RUN_ID);
});

function retainedSession(name: string): string {
  const path = join(tempDir, `${name}.jsonl`);
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id: `${name}-session`, timestamp: new Date().toISOString(), cwd: tempDir }),
    JSON.stringify({ type: "message", id: `${name}-msg`, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "Original request" } }),
  ].join("\n") + "\n");
  return path;
}

function seedCompletedRun(sessionFile: string | undefined): void {
  store.recordRunStart({ id: RUN_ID, name: "send-flow", inputs: {}, status: "completed", stages: [], startedAt: 1 });
  store.recordStageStart(RUN_ID, {
    id: "stage-a",
    name: "final",
    status: "completed",
    parentIds: [],
    toolEvents: [],
    result: "done",
    attachable: false,
    ...(sessionFile !== undefined ? { sessionFile } : {}),
  });
}

function resolvePostMortemDeps(session: StageSessionRuntime, counter: { creates: number }): (runId: string) => PostMortemStageChatDeps {
  const adapters: StageAdapters = {
    agentSession: {
      async create() { counter.creates += 1; return session; },
    },
  };
  return () => ({ registry: createStageControlRegistry(), adapters, cwd: tempDir });
}

describe("workflow send — post-mortem parity", () => {
  test("revives a retained session and delivers a follow-up", async () => {
    const sessionFile = retainedSession("send-ok");
    seedCompletedRun(sessionFile);
    const followUps: string[] = [];
    const counter = { creates: 0 };
    const session: StageSessionRuntime = { ...mockSession(), sessionFile, async followUp(text: string) { followUps.push(text); } };

    const result = await workflowSendAction(
      { runId: RUN_ID, stageId: "stage-a", text: "any regressions?" },
      { resolvePostMortemDeps: resolvePostMortemDeps(session, counter) },
    );

    assert.equal(result.status, "ok");
    assert.equal(result.delivery, "followUp");
    assert.deepEqual(followUps, ["any regressions?"]);
    assert.equal(counter.creates, 1);
    assert.equal(store.runs().find((r) => r.id === RUN_ID)?.status, "completed");
    assert.equal(store.runs().find((r) => r.id === RUN_ID)?.stages[0]?.status, "completed");
  });

  test("rejects explicit resume without appending or mutating terminal status", async () => {
    const sessionFile = retainedSession("send-no-resume");
    seedCompletedRun(sessionFile);
    const promptCalls: string[] = [];
    const counter = { creates: 0 };
    const session: StageSessionRuntime = {
      ...mockSession(),
      sessionFile,
      async prompt(text: string) { promptCalls.push(text); },
    };

    await assert.rejects(
      () => workflowSendAction(
        { runId: RUN_ID, stageId: "stage-a", text: "resume should be rejected", delivery: "resume" },
        { resolvePostMortemDeps: resolvePostMortemDeps(session, counter) },
      ),
      /Post-mortem stage chat cannot pause or resume workflow execution\./,
    );

    assert.deepEqual(promptCalls, []);
    assert.equal(counter.creates, 0);
    const run = store.runs().find((candidate) => candidate.id === RUN_ID);
    assert.equal(run?.status, "completed");
    assert.equal(run?.stages[0]?.status, "completed");
  });

  test("stays a no-op with an explicit reason when the session is invalid", async () => {
    seedCompletedRun(join(tempDir, "missing.jsonl"));
    const counter = { creates: 0 };
    const result = await workflowSendAction(
      { runId: RUN_ID, stageId: "stage-a", text: "hello" },
      { resolvePostMortemDeps: resolvePostMortemDeps(mockSession(), counter) },
    );
    assert.equal(result.status, "noop");
    assert.equal(result.message, "No live handle for stage.");
    assert.equal(counter.creates, 0);
  });

  test("stays a no-op when the stage has no retained session", async () => {
    seedCompletedRun(undefined);
    const counter = { creates: 0 };
    const result = await workflowSendAction(
      { runId: RUN_ID, stageId: "stage-a", text: "hello" },
      { resolvePostMortemDeps: resolvePostMortemDeps(mockSession(), counter) },
    );
    assert.equal(result.status, "noop");
    assert.equal(counter.creates, 0);
  });
});
