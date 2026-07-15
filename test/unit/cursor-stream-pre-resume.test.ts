import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Context, Model } from "@earendil-works/pi-ai/compat";
import { CursorStreamAdapter } from "../../packages/cursor/src/stream.js";
import type { CursorAuthorizedRoute } from "../../packages/cursor/src/execution-authority.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";
import { collectEvents, context, model, testAuthorizedRoute } from "./cursor-stream-helpers.js";

const exactTestAuthorization: CursorAuthorizedRoute = testAuthorizedRoute({
	modelId: model().id,
	maxMode: false,
	credentialScope: "scope-a",
	catalogGeneration: 1,
});

function toolResultContext(): Context {
	return { messages: [{ role: "toolResult", toolCallId: "tool-1", toolName: "Read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 2 }] };
}

test("a pre-resume authorization failure preserves the paused tool turn for a later authorized retry", async () => {
	// Finding 4: an authorization failure (missing key / wrong account / removed
	// or expired route) that occurs BEFORE resumeTurnWithToolResults begins must
	// surface an error but leave the still-paused turn intact so a later
	// authorized retry can resume it.
	let rejectAuthorization = false;
	const transport = new CursorMockTransport({ messages: [
		{ type: "toolCall", id: "tool-1", name: "Read", argumentsJson: "{}" },
		{ type: "textDelta", text: "done" },
		{ type: "done", reason: "stop" },
	] });
	const adapter = new CursorStreamAdapter({
		transport,
		executionAuthorizer: async () => {
			if (rejectAuthorization) throw new Error("current Cursor route expired or was removed");
			return exactTestAuthorization;
		},
	});
	await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret", sessionId: "removed-route" }));
	assert.equal(adapter.getLifecycleSnapshot().activeTurns, 1);

	rejectAuthorization = true;
	const rejected = await collectEvents(adapter.streamSimple(model(), toolResultContext(), { apiKey: "access-secret", sessionId: "removed-route" }));
	assert.equal(rejected.at(-1)?.type, "error");
	assert.equal(transport.runs[0]?.stream.writtenToolResults.length, 0);
	assert.equal(transport.runs[0]?.stream.cancelled, false);
	assert.equal(adapter.getLifecycleSnapshot().activeTurns, 1);

	rejectAuthorization = false;
	const retry = await collectEvents(adapter.streamSimple(model(), toolResultContext(), { apiKey: "access-secret", sessionId: "removed-route" }));
	assert.equal(retry.at(-1)?.type, "done");
	assert.equal(transport.runs.length, 1);
	assert.equal(transport.runs[0]?.stream.writtenToolResults.length, 1);
	await adapter.dispose();
});

test("a caller abort while the resume authorizer is pending preserves the paused turn", async () => {
	// Finding 4: caller cancellation during a pending resume authorization must
	// terminate the stream as bounded start,error(aborted) without cancelling the
	// still-paused turn; a later authorized resume must still succeed.
	const transport = new CursorMockTransport({ messages: [
		{ type: "toolCall", id: "tool-1", name: "Read", argumentsJson: "{}" },
		{ type: "textDelta", text: "done" },
		{ type: "done", reason: "stop" },
	] });
	const gate = Promise.withResolvers<void>();
	const authorizerStarted = Promise.withResolvers<void>();
	let holdAuthorizer = false;
	const adapter = new CursorStreamAdapter({
		transport,
		// Mirror the real authorizer, which races its wait against the caller signal.
		executionAuthorizer: async (_selected: Model<Api>, _accessToken: string, signal?: AbortSignal) => {
			if (holdAuthorizer) {
				authorizerStarted.resolve();
				await new Promise<void>((resolve, reject) => {
					const onAbort = (): void => reject(new Error("authorizer aborted"));
					if (signal?.aborted) { onAbort(); return; }
					signal?.addEventListener("abort", onAbort, { once: true });
					void gate.promise.then(() => { signal?.removeEventListener("abort", onAbort); resolve(); });
				});
			}
			return exactTestAuthorization;
		},
	});
	await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret", sessionId: "abort-pending" }));
	assert.equal(adapter.getLifecycleSnapshot().activeTurns, 1);

	holdAuthorizer = true;
	const controller = new AbortController();
	const iterator = adapter.streamSimple(model(), toolResultContext(), { apiKey: "access-secret", sessionId: "abort-pending", signal: controller.signal })[Symbol.asyncIterator]();
	const first = await iterator.next();
	assert.equal(first.value?.type, "start");
	await authorizerStarted.promise;
	controller.abort();
	const terminal = await iterator.next();
	assert.equal(terminal.value?.type, "error");
	assert.equal((await iterator.next()).done, true);
	gate.resolve();
	await Promise.resolve();
	assert.equal(transport.runs[0]?.stream.writtenToolResults.length, 0);
	assert.equal(transport.runs[0]?.stream.cancelled, false);
	assert.equal(adapter.getLifecycleSnapshot().activeTurns, 1);

	holdAuthorizer = false;
	const retry = await collectEvents(adapter.streamSimple(model(), toolResultContext(), { apiKey: "access-secret", sessionId: "abort-pending" }));
	assert.equal(retry.at(-1)?.type, "done");
	assert.equal(transport.runs[0]?.stream.writtenToolResults.length, 1);
	await adapter.dispose();
});
