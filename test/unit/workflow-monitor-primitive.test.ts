import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { WORKFLOW_MONITOR_INTERCOM_EVENT } from "../../packages/workflows/src/engine/primitives/monitor.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { AgentSession } from "@bastani/atomic";

function mockSession(): StageSessionRuntime {
  return {
    async prompt() {},
    async steer() {},
    async followUp() {},
    subscribe() { return () => {}; },
    sessionFile: undefined,
    sessionId: "sess-1",
    async setModel() {},
    setThinkingLevel() {},
    cycleModel: (async () => undefined) as StageSessionRuntime["cycleModel"],
    cycleThinkingLevel: (() => undefined) as StageSessionRuntime["cycleThinkingLevel"],
    agent: undefined as unknown as AgentSession["agent"],
    model: undefined as unknown as AgentSession["model"],
    thinkingLevel: "medium" as AgentSession["thinkingLevel"],
    messages: [] as AgentSession["messages"],
    isStreaming: false,
    navigateTree: (async () => ({ cancelled: false })) as StageSessionRuntime["navigateTree"],
    compact: (async () => ({})) as unknown as StageSessionRuntime["compact"],
    abortCompaction() {},
    async abort() {},
    dispose() {},
    getLastAssistantText() { return "ok"; },
  };
}

function failingSession(): StageSessionRuntime {
  return {
    ...mockSession(),
    async prompt() { throw new Error("stage failed"); },
    getLastAssistantText() { return undefined; },
  };
}

function slowSession(blocked: { resolve: () => void }): StageSessionRuntime {
  return {
    ...mockSession(),
    async prompt() { blocked.resolve(); await new Promise(() => {}); },
  };
}

describe("ctx.monitor primitive", () => {
  test("single-stage monitor: fires onStart on running and onStop with completed", async () => {
    const intercomEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const lifecycle: Array<{ kind: string; stageName?: string; status?: string }> = [];
    const def = workflow({
      name: "monitor-single",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        ctx.monitor("analyze", {
          onStart: (info) => { lifecycle.push({ kind: "start", stageName: info.stageName }); },
          onStop: (info) => { lifecycle.push({ kind: "stop", stageName: info.stageName, status: info.status }); },
        });
        await ctx.stage("analyze").sendUserMessage("do work");
        return {};
      },
    });

    const result = await run(def, {}, {
      store: createStore(),
      adapters: { agentSession: { create: async () => mockSession() } },
      monitorIntercom: { emit: (event, payload) => { intercomEvents.push({ event, payload }); } },
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(lifecycle, [{ kind: "start", stageName: "analyze" }, { kind: "stop", stageName: "analyze", status: "completed" }]);
    const startEvents = intercomEvents.filter((e) => e.payload["kind"] === "start");
    const stopEvents = intercomEvents.filter((e) => e.payload["kind"] === "stop");
    assert.equal(startEvents.length, 1);
    assert.equal(stopEvents.length, 1);
    assert.equal(startEvents[0]!.event, WORKFLOW_MONITOR_INTERCOM_EVENT);
    assert.equal(stopEvents[0]!.payload["status"], "completed");
  });

  test("single-stage monitor: onStop fires with failed when stage throws", async () => {
    const lifecycle: Array<{ kind: string; status?: string }> = [];
    const def = workflow({
      name: "monitor-fail",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        ctx.monitor("boom", {
          onStart: () => { lifecycle.push({ kind: "start" }); },
          onStop: (info) => { lifecycle.push({ kind: "stop", status: info.status }); },
        });
        await ctx.stage("boom").sendUserMessage("fail");
        return {};
      },
    });

    const result = await run(def, {}, {
      store: createStore(),
      adapters: { agentSession: { create: async () => failingSession() } },
    });

    assert.equal(result.status, "failed");
    assert.deepEqual(lifecycle, [{ kind: "start" }, { kind: "stop", status: "failed" }]);
  });

  test("single-stage monitor: onStop fires with skipped on ctx.exit", async () => {
    const lifecycle: Array<{ kind: string; status?: string }> = [];
    const blocker = Promise.withResolvers<void>();
    const def = workflow({
      name: "monitor-exit",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        ctx.monitor("long", {
          onStart: () => { lifecycle.push({ kind: "start" }); },
          onStop: (info) => { lifecycle.push({ kind: "stop", status: info.status }); },
        });
        void ctx.stage("long").sendUserMessage("hang").catch(() => {});
        blocker.resolve();
        // Allow the stage to start, then exit
        await new Promise((resolve) => setTimeout(resolve, 10));
        ctx.exit();
        return {};
      },
    });

    const result = await run(def, {}, {
      store: createStore(),
      adapters: { agentSession: { create: async () => slowSession(blocker) } },
    });
    assert.equal(result.exited, true);
    assert.deepEqual(lifecycle, [{ kind: "start" }, { kind: "stop", status: "skipped" }]);
  });

  test("multi-stage monitor: aggregate liveness across sequential stages", async () => {
    const lifecycle: Array<{ kind: string; stageName?: string }> = [];
    const def = workflow({
      name: "monitor-multi",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        ctx.monitor(["a", "b"], {
          onStart: (info) => { lifecycle.push({ kind: "start", stageName: info.stageName }); },
          onStop: (info) => { lifecycle.push({ kind: "stop", stageName: info.stageName }); },
        });
        await ctx.stage("a").sendUserMessage("a");
        await ctx.stage("b").sendUserMessage("b");
        return {};
      },
    });

    const result = await run(def, {}, {
      store: createStore(),
      adapters: { agentSession: { create: async () => mockSession() } },
    });

    assert.equal(result.status, "completed");
    // Sequential stages: first "a" starts (count 0→1), "a" stops (count 1→0),
    // then "b" starts (count 0→1), "b" stops (count 1→0).
    // Two separate start/stop windows.
    assert.equal(lifecycle.filter((e) => e.kind === "start").length, 2);
    assert.equal(lifecycle.filter((e) => e.kind === "stop").length, 2);
    assert.equal(lifecycle[0]!.stageName, "a");
    assert.equal(lifecycle[2]!.stageName, "b");
  });

  test("multi-stage monitor: stays live while overlapping stages run", async () => {
    const lifecycle: Array<{ kind: string; stageName?: string }> = [];
    const startedStages: string[] = [];
    const releaseAll = Promise.withResolvers<void>();
    let callCount = 0;

    const def = workflow({
      name: "monitor-overlap",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        ctx.monitor(["a", "b"], {
          onStart: (info) => { lifecycle.push({ kind: "start", stageName: info.stageName }); },
          onStop: (info) => { lifecycle.push({ kind: "stop", stageName: info.stageName }); },
        });
        // Start both in parallel so they overlap
        await Promise.all([
          ctx.stage("a").sendUserMessage("a"),
          ctx.stage("b").sendUserMessage("b"),
        ]);
        return {};
      },
    });

    // Shared session factory: every prompt call blocks until releaseAll.
    // Both stages' prompts enter simultaneously and only resolve together,
    // guaranteeing overlap.
    const createSession = (): StageSessionRuntime => {
      const myCall = ++callCount;
      return {
        ...mockSession(),
        async prompt() {
          startedStages.push(`call-${myCall}`);
          await releaseAll.promise;
        },
      };
    };

    // Release after a short delay so both stages have started
    setTimeout(() => releaseAll.resolve(), 50);

    const result = await run(def, {}, {
      store: createStore(),
      adapters: { agentSession: { create: async () => createSession() } },
    });

    assert.equal(result.status, "completed");
    assert.equal(startedStages.length, 2, "both stages should have started prompts");
    // Overlapping: both stages running at once means activeCount goes 0→1→2
    // then 2→1→0. Only one start (at 0→1) and one stop (at 1→0).
    assert.equal(lifecycle.filter((e) => e.kind === "start").length, 1);
    assert.equal(lifecycle.filter((e) => e.kind === "stop").length, 1);
  });

  test("registration before stage exists does not throw and arms correctly", async () => {
    const lifecycle: Array<{ kind: string }> = [];
    const def = workflow({
      name: "monitor-register-first",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        // Register monitor before the stage is created
        const handle = ctx.monitor("later", {
          onStart: () => { lifecycle.push({ kind: "start" }); },
          onStop: () => { lifecycle.push({ kind: "stop" }); },
        });
        assert.deepEqual([...handle.stages], ["later"]);
        await ctx.stage("later").sendUserMessage("work");
        return {};
      },
    });

    const result = await run(def, {}, {
      store: createStore(),
      adapters: { agentSession: { create: async () => mockSession() } },
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(lifecycle, [{ kind: "start" }, { kind: "stop" }]);
  });

  test("unmonitored stage does not trigger monitor callbacks", async () => {
    const lifecycle: Array<{ kind: string }> = [];
    const def = workflow({
      name: "monitor-unrelated",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        ctx.monitor("watched", {
          onStart: () => { lifecycle.push({ kind: "start" }); },
          onStop: () => { lifecycle.push({ kind: "stop" }); },
        });
        await ctx.stage("unwatched").sendUserMessage("no monitor");
        return {};
      },
    });

    const result = await run(def, {}, {
      store: createStore(),
      adapters: { agentSession: { create: async () => mockSession() } },
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(lifecycle, []);
  });

  test("monitor emits on the configured channel", async () => {
    const intercomEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const def = workflow({
      name: "monitor-channel",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        ctx.monitor("s", { channel: "my-custom-channel" });
        await ctx.stage("s").sendUserMessage("work");
        return {};
      },
    });

    await run(def, {}, {
      store: createStore(),
      adapters: { agentSession: { create: async () => mockSession() } },
      monitorIntercom: { emit: (event, payload) => { intercomEvents.push({ event, payload }); } },
    });

    const startEvent = intercomEvents.find((e) => e.payload["kind"] === "start");
    assert.equal(startEvent?.payload["channel"], "my-custom-channel");
  });
});
