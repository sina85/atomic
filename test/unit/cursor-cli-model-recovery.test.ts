import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { recoverUnresolvedCursorCliModel } from "../../packages/coding-agent/src/main-cursor-model-recovery.js";
import type { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";

function cursorModel(id: string): Model<Api> {
	return {
		provider: "cursor",
		id,
		name: id,
		api: "cursor-agent",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	} as Model<Api>;
}

test("retries an unresolved authenticated Cursor CLI row after blocking discovery", async () => {
	let models = [cursorModel("default")];
	const registry = { getAll: () => models } as ModelRegistry;
	let selected: Model<Api> | undefined;
	let thinking: ThinkingLevel | undefined;
	let contextWindow: number | undefined;
	let discoveries = 0;
	const notFound = 'Model "cursor/composer-2.5-fast" not found. Use --list-models to see available models.';
	const warning = { type: "warning" as const, message: "keep me" };

	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliModel: "Cursor/composer-2.5-fast",
		cliThinking: "off",
		cliContextWindow: 1_000_000,
		diagnostics: [{ type: "error", message: notFound }, warning],
		modelRegistry: registry,
		session: {
			setModel: async (model) => { selected = model; },
			setThinkingLevel: (level) => { thinking = level; },
			setContextWindow: (value) => { contextWindow = value; },
		},
		discoverModels: async () => {
			discoveries += 1;
			models = [cursorModel("default"), cursorModel("composer-2.5-fast")];
		},
	});

	assert.equal(discoveries, 1);
	assert.equal(selected?.id, "composer-2.5-fast");
	assert.equal(thinking, "off");
	assert.equal(contextWindow, 1_000_000);
	assert.deepEqual(diagnostics, [warning]);
});

test("preserves the fatal diagnostic when authenticated discovery cannot resolve the exact row", async () => {
	const registry = { getAll: () => [cursorModel("default")] } as ModelRegistry;
	const error = { type: "error" as const, message: 'Model "cursor/missing" not found. Use --list-models to see available models.' };
	let selected = false;
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliModel: "cursor/missing",
		diagnostics: [error],
		modelRegistry: registry,
		session: {
			setModel: async () => { selected = true; },
			setThinkingLevel: () => undefined,
			setContextWindow: () => undefined,
		},
		discoverModels: async () => undefined,
	});
	assert.equal(selected, false);
	assert.deepEqual(diagnostics, [error]);
});

test("recovers a valid model with a case-insensitive --provider Cursor flag", async () => {
	let models = [cursorModel("default")];
	const registry = { getAll: () => models } as ModelRegistry;
	let selected: Model<Api> | undefined;
	const error = { type: "error" as const, message: 'Model "cursor/composer-2.5-fast" not found. Use --list-models to see available models.' };
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliProvider: "Cursor",
		cliModel: "cursor/composer-2.5-fast",
		diagnostics: [error],
		modelRegistry: registry,
		session: {
			setModel: async (model) => { selected = model; },
			setThinkingLevel: () => undefined,
			setContextWindow: () => undefined,
		},
		discoverModels: async () => {
			models = [cursorModel("default"), cursorModel("composer-2.5-fast")];
		},
	});
	assert.equal(selected?.id, "composer-2.5-fast");
	assert.deepEqual(diagnostics, []);
});

test("does not recover a fuzzy or similar Cursor model ID", async () => {
	let models = [cursorModel("default"), cursorModel("gpt-5.2-codex-fast")];
	const registry = { getAll: () => models } as ModelRegistry;
	const error = { type: "error" as const, message: 'Model "cursor/gpt-5.2-cod" not found. Use --list-models to see available models.' };
	let selected = false;
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliProvider: "Cursor",
		cliModel: "gpt-5.2-cod",
		diagnostics: [],
		modelRegistry: registry,
		session: {
			setModel: async () => { selected = true; },
			setThinkingLevel: () => undefined,
			setContextWindow: () => undefined,
		},
		discoverModels: async () => {
			models = [cursorModel("default"), cursorModel("gpt-5.2-codex-fast")];
		},
	});
	assert.equal(selected, false);
	assert.deepEqual(diagnostics, [error]);
});

test("rejects an exact compatibility-only Cursor ID absent from authenticated discovery", async () => {
	let models = [cursorModel("claude-4-sonnet-thinking")];
	const registry = { getAll: () => models } as ModelRegistry;
	let selected = false;
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliProvider: "cursor",
		cliModel: "claude-4-sonnet-thinking",
		diagnostics: [],
		modelRegistry: registry,
		session: {
			setModel: async () => { selected = true; },
			setThinkingLevel: () => undefined,
			setContextWindow: () => undefined,
		},
		discoverModels: async () => { models = [cursorModel("default")]; },
	});
	assert.equal(selected, false);
	assert.deepEqual(diagnostics, [{
		type: "error",
		message: 'Model "cursor/claude-4-sonnet-thinking" not found. Use --list-models to see available models.',
	}]);
});

test("reports an invalid deferred context window as a startup diagnostic", async () => {
	let models = [cursorModel("default")];
	const registry = { getAll: () => models } as ModelRegistry;
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliModel: "cursor/composer-2.5-fast",
		cliContextWindow: 12_345,
		diagnostics: [{ type: "error", message: 'Model "cursor/composer-2.5-fast" not found. Use --list-models to see available models.' }],
		modelRegistry: registry,
		session: {
			setModel: async () => undefined,
			setThinkingLevel: () => undefined,
			setContextWindow: () => { throw new Error("Context window 12345 is not supported by cursor/composer-2.5-fast."); },
		},
		discoverModels: async () => { models = [cursorModel("default"), cursorModel("composer-2.5-fast")]; },
	});
	assert.deepEqual(diagnostics, [{ type: "error", message: "Context window 12345 is not supported by cursor/composer-2.5-fast." }]);
});
