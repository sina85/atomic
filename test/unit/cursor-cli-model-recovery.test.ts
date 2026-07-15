import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { recoverCursorCliModelAfterExtensionStartup, recoverUnresolvedCursorCliModel, type CursorStartupRecoveryRuntime } from "../../packages/coding-agent/src/main-cursor-model-recovery.js";
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

function reselectionError(reference: string): { readonly type: "error"; readonly message: string } {
	return {
		type: "error",
		message: `Model "${reference}" not found. Cursor model IDs changed; reselect an exact model with --list-models.`,
	};
}

test("retries an unresolved authenticated Cursor CLI row after blocking discovery", async () => {
	let models = [cursorModel("default")];
	const registry = { getAll: () => models } as ModelRegistry;
	let selected: Model<Api> | undefined;
	let contextWindow: number | undefined;
	let discoveries = 0;
	const notFound = 'Model "cursor/composer-2.5-fast" not found. Use --list-models to see available models.';
	const warning = { type: "warning" as const, message: "keep me" };

	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliModel: "cursor/composer-2.5-fast",
		cliContextWindow: 1_000_000,
		diagnostics: [{ type: "error", message: notFound }, warning],
		modelRegistry: registry,
		session: {
			setModel: async (model) => { selected = model; },
			setContextWindow: (value) => { contextWindow = value; },
		},
		discoverModels: async () => {
			discoveries += 1;
			models = [cursorModel("default"), cursorModel("composer-2.5-fast")];
		},
	});

	assert.equal(discoveries, 1);
	assert.equal(selected?.id, "composer-2.5-fast");
	assert.equal(contextWindow, 1_000_000);
	assert.deepEqual(diagnostics, [warning]);
});

test("drops a stale unknown-provider diagnostic when discovery already raced ahead", async () => {
	const exact = cursorModel("gpt-5.2");
	const registry = { getAll: () => [exact] } as ModelRegistry;
	let selected: Model<Api> | undefined;
	const warning = { type: "warning" as const, message: "keep me" };
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliProvider: "cursor",
		cliModel: "gpt-5.2",
		diagnostics: [
			{ type: "error", message: 'Unknown provider "cursor". Use --list-models to see available providers/models.' },
			warning,
		],
		modelRegistry: registry,
		session: {
			setModel: async (model) => { selected = model; },
			setContextWindow: () => undefined,
		},
		discoverModels: async () => undefined,
	});
	assert.equal(selected, exact);
	assert.deepEqual(diagnostics, [warning]);
});

test("drops a stale breaking-ID diagnostic when a provider-scoped exact route is current", async () => {
	const exact = cursorModel("gpt-5.2");
	let selected: Model<Api> | undefined;
	const stale = reselectionError("cursor/gpt-5.2");
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliProvider: "cursor",
		cliModel: "gpt-5.2",
		diagnostics: [stale],
		modelRegistry: { getAll: () => [exact] },
		session: {
			setModel: async (model) => { selected = model; },
			setContextWindow: () => undefined,
		},
		discoverModels: async () => undefined,
	});
	assert.equal(selected, exact);
	assert.deepEqual(diagnostics, []);
});

test("startup recovery selects the first exact duplicate and accepts cursor slash for a blank row", async () => {
	const first = cursorModel("duplicate");
	const second = { ...cursorModel("duplicate"), name: "second" };
	const blank = cursorModel("");
	for (const [cliModel, expected] of [["cursor/duplicate", first], ["cursor/", blank]] as const) {
		let selected: Model<Api> | undefined;
		const diagnostics = await recoverUnresolvedCursorCliModel({
			cliModel,
			diagnostics: [{ type: "error", message: `Model "${cliModel}" not found. Use --list-models to see available models.` }],
			modelRegistry: { getAll: () => [first, second, blank] } as ModelRegistry,
			session: {
				setModel: async (model) => { selected = model; },
				setContextWindow: () => undefined,
			},
			discoverModels: async () => undefined,
		});
		assert.equal(selected, expected);
		assert.deepEqual(diagnostics, []);
	}
});

test("recovers a blank route supplied with the separate exact Cursor provider", async () => {
	const blank = cursorModel("");
	let selected: Model<Api> | undefined;
	let discoveries = 0;
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliProvider: "cursor",
		cliModel: "",
		diagnostics: [{ type: "error", message: 'Model "cursor/" not found. Use --list-models to see available models.' }],
		modelRegistry: { getAll: () => [blank] } as ModelRegistry,
		session: {
			setModel: async (model) => { selected = model; },
			setContextWindow: () => undefined,
		},
		discoverModels: async () => { discoveries += 1; },
	});
	assert.equal(discoveries, 1);
	assert.equal(selected, blank);
	assert.deepEqual(diagnostics, []);
});

test("does not recover normalized provider-qualified Cursor text", async () => {
	for (const cliModel of ["CURSOR/route", "CuRsOr/route", " cursor/route", "cursor /route"]) {
		let discoveries = 0;
		let selected = false;
		const diagnostics = [{ type: "error" as const, message: `Model "${cliModel}" not found.` }];
		const result = await recoverUnresolvedCursorCliModel({
			cliModel,
			diagnostics,
			modelRegistry: { getAll: () => [cursorModel("route")] } as ModelRegistry,
			session: {
				setModel: async () => { selected = true; },
				setContextWindow: () => undefined,
			},
			discoverModels: async () => { discoveries += 1; },
		});
		assert.equal(discoveries, 0, cliModel);
		assert.equal(selected, false, cliModel);
		assert.deepEqual(result, diagnostics, cliModel);
	}
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
			setContextWindow: () => undefined,
		},
		discoverModels: async () => undefined,
	});
	assert.equal(selected, false);
	assert.deepEqual(diagnostics, [reselectionError("cursor/missing")]);
});

test("does not recover a normalized --provider Cursor flag", async () => {
	let models = [cursorModel("default")];
	const registry = { getAll: () => models } as ModelRegistry;
	let selected: Model<Api> | undefined;
	let discoveries = 0;
	const error = { type: "error" as const, message: 'Unknown provider "Cursor". Use --list-models to see available providers/models.' };
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliProvider: "Cursor",
		cliModel: "composer-2.5-fast",
		diagnostics: [error],
		modelRegistry: registry,
		session: {
			setModel: async (model) => { selected = model; },
			setContextWindow: () => undefined,
		},
		discoverModels: async () => {
			discoveries += 1;
			models = [cursorModel("default"), cursorModel("composer-2.5-fast")];
		},
	});
	assert.equal(discoveries, 0);
	assert.equal(selected, undefined);
	assert.deepEqual(diagnostics, [error]);
});

test("does not recover a fuzzy or similar Cursor model ID", async () => {
	let models = [cursorModel("default"), cursorModel("gpt-5.2-codex-fast")];
	const registry = { getAll: () => models } as ModelRegistry;
	const error = reselectionError("cursor/gpt-5.2-cod");
	let selected = false;
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliProvider: "cursor",
		cliModel: "gpt-5.2-cod",
		diagnostics: [],
		modelRegistry: registry,
		session: {
			setModel: async () => { selected = true; },
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
			setContextWindow: () => undefined,
		},
		discoverModels: async () => { models = [cursorModel("default")]; },
	});
	assert.equal(selected, false);
	assert.deepEqual(diagnostics, [reselectionError("cursor/claude-4-sonnet-thinking")]);
});

test("does not recover a case-normalized Cursor route ID", async () => {
	let models = [cursorModel("default")];
	const registry = { getAll: () => models } as ModelRegistry;
	let selected = false;
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliProvider: "cursor",
		cliModel: "CURSOR-GROK-4.5-HIGH",
		diagnostics: [],
		modelRegistry: registry,
		session: {
			setModel: async () => { selected = true; },
			setContextWindow: () => undefined,
		},
		discoverModels: async () => { models = [cursorModel("cursor-grok-4.5-high")]; },
	});
	assert.equal(selected, false);
	assert.deepEqual(diagnostics, [reselectionError("cursor/CURSOR-GROK-4.5-HIGH")]);
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
			setContextWindow: () => { throw new Error("Context window 12345 is not supported by cursor/composer-2.5-fast."); },
		},
		discoverModels: async () => { models = [cursorModel("default"), cursorModel("composer-2.5-fast")]; },
	});
	assert.deepEqual(diagnostics, [{ type: "error", message: "Context window 12345 is not supported by cursor/composer-2.5-fast." }]);
});

test("a bare former-legacy id is not a Cursor recovery target and triggers no discovery", async () => {
	const other = { ...cursorModel("composer-2"), provider: "openai", api: "openai-responses" } as Model<Api>;
	let discovered = false;
	let selected = false;
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliModel: "composer-2", diagnostics: [], modelRegistry: { getAll: () => [other] },
		session: { setModel: async () => { selected = true; }, setContextWindow: () => undefined },
		discoverModels: async () => { discovered = true; },
	});
	// Bare ids are ordinary non-Cursor references; the initial resolver already
	// handled them, so post-discovery Cursor recovery is skipped entirely.
	assert.equal(discovered, false);
	assert.equal(selected, false);
	assert.deepEqual(diagnostics, []);
});

test("an explicit cursor/<id> reference selects the live route after discovery", async () => {
	let models: Model<Api>[] = [];
	let selected: Model<Api> | undefined;
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliModel: "cursor/composer-2", diagnostics: [], modelRegistry: { getAll: () => models },
		session: { setModel: async (model) => { selected = model; }, setContextWindow: () => undefined },
		discoverModels: async () => { models = [cursorModel("composer-2")]; },
	});
	assert.equal(selected?.provider, "cursor");
	assert.equal(selected?.id, "composer-2");
	assert.deepEqual(diagnostics, []);
});

test("an explicit cursor/<id> reference absent after discovery reports a reselection failure", async () => {
	let selected = false;
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliModel: "cursor/composer-2", diagnostics: [], modelRegistry: { getAll: () => [] },
		session: { setModel: async () => { selected = true; }, setContextWindow: () => undefined },
		discoverModels: async () => undefined,
	});
	assert.equal(selected, false);
	assert.deepEqual(diagnostics, [reselectionError("cursor/composer-2")]);
});

test("persisted Cursor reselection failures are fatal in every CLI startup mode", async () => {
	const message = "Could not restore Cursor model cursor/old-route. Cursor model IDs changed; reselect an exact model with --list-models.";
	const runtime = {
		modelFallbackMessage: message,
		diagnostics: [],
		services: { modelRegistry: { getAll: () => [] } },
		session: {
			setModel: async () => undefined,
			setContextWindow: () => undefined,
			discoverExtensionModels: async () => undefined,
		},
	} satisfies CursorStartupRecoveryRuntime;
	for (const mode of ["interactive", "print", "json", "rpc"] as const) {
		const diagnostics = await recoverCursorCliModelAfterExtensionStartup({}, runtime, mode);
		assert.deepEqual(diagnostics, [{ type: "error", message }]);
	}
});

test("a deferred interactive settings-only Cursor reselection message is not escalated to a fatal startup error", async () => {
	// Finding 2: when extensions are deferred for an interactive TTY, the empty
	// pre-load runner cannot see the dynamic route, so the eager recovery yields a
	// reselection message. It must remain on modelFallbackMessage for the post-load
	// retry rather than becoming a fatal startup diagnostic.
	for (const message of [
		"Could not select saved Cursor model cursor/saved-exact. Cursor model IDs changed; reselect an exact model with --list-models.",
		"Could not select saved Cursor model cursor/. Cursor model IDs changed; reselect an exact model with --list-models.",
	]) {
		const runtime = {
			modelFallbackMessage: message,
			diagnostics: [],
			services: { modelRegistry: { getAll: () => [] } },
			session: {
				setModel: async () => undefined,
				setContextWindow: () => undefined,
				discoverExtensionModels: async () => undefined,
			},
		} satisfies CursorStartupRecoveryRuntime;
		const deferred = await recoverCursorCliModelAfterExtensionStartup({}, runtime, "interactive", true);
		assert.deepEqual(deferred, []);

		// Controls: a nondeferred interactive start and a deferred noninteractive
		// start both remain fatal.
		assert.deepEqual(await recoverCursorCliModelAfterExtensionStartup({}, runtime, "interactive", false), [{ type: "error", message }]);
		assert.deepEqual(await recoverCursorCliModelAfterExtensionStartup({}, runtime, "print", true), [{ type: "error", message }]);
	}
});
