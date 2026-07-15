import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { findExactModelReferenceMatch, parseModelPattern, resolveCliModel } from "../src/core/model-resolver.ts";
import { resolveModelScopeWithDiagnostics } from "../src/core/model-resolver-scope.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

const exactId = "cursor-grok-4.5-high";
const staleId = "grok-4.5-high";

function cursorModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

function cursorRegistry(): ModelRegistry {
	const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
	registry.registerProvider("cursor", {
		baseUrl: "https://api2.cursor.sh",
		apiKey: "cursor-test-key",
		api: "cursor-agent",
		models: [cursorModel(exactId)],
	});
	return registry;
}

describe("Cursor exact model resolution", () => {
	test("resolves only the exact authenticated flat route", () => {
		const result = resolveCliModel({
			cliProvider: "cursor",
			cliModel: exactId,
			modelRegistry: cursorRegistry(),
		});
		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe(exactId);
		expect(result.thinkingLevel).toBeUndefined();
	});

	test("accepts exact bare and provider-qualified current route IDs", () => {
		for (const cliModel of [exactId, `cursor/${exactId}`]) {
			const result = resolveCliModel({ cliModel, modelRegistry: cursorRegistry() });
			expect(result.model?.id).toBe(exactId);
			expect(result.error).toBeUndefined();
		}
	});

	test("preserves a thinking-like suffix when it is part of the exact flat route ID", () => {
		const id = "cursor-route:high";
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		registry.registerProvider("cursor", {
			baseUrl: "https://api2.cursor.sh", apiKey: "cursor-test-key", api: "cursor-agent", models: [cursorModel(id)],
		});
		expect(resolveCliModel({ cliModel: `cursor/${id}`, modelRegistry: registry }).model?.id).toBe(id);
	});

	test("raw exact Cursor text selects the first duplicate and accepts a blank qualified route", () => {
		const first = cursorModel("duplicate");
		const second = { ...cursorModel("duplicate"), name: "second" };
		const blank = cursorModel("");
		const available = [first, second, blank];
		expect(findExactModelReferenceMatch("duplicate", available)).toBe(first);
		expect(findExactModelReferenceMatch("cursor/duplicate", available)).toBe(first);
		expect(findExactModelReferenceMatch("cursor/", available)).toBe(blank);
	});

	test("generic reasoning parsing cannot rewrite text into a Cursor route", () => {
		const base = cursorModel("route");
		const literal = cursorModel("route:high");
		expect(parseModelPattern("route:high", [base]).model).toBeUndefined();
		const exact = parseModelPattern("route:high", [base, literal]);
		expect(exact.model).toBe(literal);
		expect(exact.thinkingLevel).toBeUndefined();
	});

	test("rejects normalized Cursor provider qualifiers across exact, CLI, pattern, and scope resolution", async () => {
		const route = cursorModel("route");
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		registry.registerProvider("cursor", {
			baseUrl: "https://api2.cursor.sh", apiKey: "cursor-test-key", api: "cursor-agent", models: [route],
		});
		for (const reference of ["CURSOR/route", "CuRsOr/route", " cursor/route", "cursor /route"]) {
			expect(findExactModelReferenceMatch(reference, [route]), reference).toBeUndefined();
			expect(parseModelPattern(reference, [route]).model, reference).toBeUndefined();
			expect(resolveCliModel({ cliModel: reference, modelRegistry: registry }).model, reference).toBeUndefined();
			const scope = await resolveModelScopeWithDiagnostics([reference], registry);
			expect(scope.scopedModels, reference).toEqual([]);
		}
	});

	test("does not reinterpret a normalized qualifier variant as a bare Cursor route ID", async () => {
		const lookalike = cursorModel("CURSOR/route");
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		registry.registerProvider("cursor", {
			baseUrl: "https://api2.cursor.sh", apiKey: "cursor-test-key", api: "cursor-agent", models: [lookalike],
		});
		expect(findExactModelReferenceMatch("CURSOR/route", [lookalike])).toBeUndefined();
		expect(parseModelPattern("CURSOR/route", [lookalike]).model).toBeUndefined();
		expect(resolveCliModel({ cliModel: "CURSOR/route", modelRegistry: registry }).model).toBeUndefined();
		expect((await resolveModelScopeWithDiagnostics(["CURSOR/route"], registry)).scopedModels).toEqual([]);
	});

	test("requires an exact lowercase explicit Cursor provider while preserving non-Cursor provider normalization", () => {
		const registry = cursorRegistry();
		registry.registerProvider("openai", {
			baseUrl: "https://example.invalid", apiKey: "test", api: "openai-responses",
			models: [{ ...cursorModel("gpt-5-mini"), provider: "openai", api: "openai-responses" }],
		});
		for (const cliProvider of ["CURSOR", "Cursor", " cursor", "cursor "]) {
			expect(resolveCliModel({ cliProvider, cliModel: exactId, modelRegistry: registry }).model, cliProvider).toBeUndefined();
		}
		expect(resolveCliModel({ cliProvider: "cursor", cliModel: exactId, modelRegistry: registry }).model?.id).toBe(exactId);
		expect(resolveCliModel({ cliProvider: "OPENAI", cliModel: "gpt-5-mini", modelRegistry: registry }).model?.provider).toBe("openai");
	});


	test("coexisting exact cursor and custom Cursor providers never collide", () => {
		const registry = cursorRegistry();
		registry.registerProvider("Cursor", {
			baseUrl: "https://custom.invalid", apiKey: "custom", api: "anthropic-messages",
			models: [{ ...cursorModel("route"), provider: "Cursor", api: "anthropic-messages" }],
		});
		expect(resolveCliModel({ cliProvider: "cursor", cliModel: exactId, modelRegistry: registry }).model?.provider).toBe("cursor");
		expect(resolveCliModel({ cliProvider: "Cursor", cliModel: "route", modelRegistry: registry }).model?.provider).toBe("Cursor");
		expect(resolveCliModel({ cliProvider: "CURSOR", cliModel: "route", modelRegistry: registry }).model?.provider).toBe("Cursor");
		expect(resolveCliModel({ cliModel: "Cursor/route", modelRegistry: registry }).model?.provider).toBe("Cursor");
	});

	test("scope treats a custom Cursor provider as ordinary non-Cursor identity", async () => {
		const registry = cursorRegistry();
		registry.registerProvider("Cursor", {
			baseUrl: "https://custom.invalid", apiKey: "custom", api: "anthropic-messages",
			models: [{ ...cursorModel("route"), provider: "Cursor", api: "anthropic-messages" }],
		});
		const result = await resolveModelScopeWithDiagnostics(["Cursor/route"], registry);
		expect(result.scopedModels.map((entry) => `${entry.model.provider}/${entry.model.id}`)).toEqual(["Cursor/route"]);
		expect(result.diagnostics).toEqual([]);
	});
	for (const entry of [
		{ name: "explicit provider", cliProvider: "cursor", cliModel: staleId },
		{ name: "provider reference", cliModel: `cursor/${staleId}` },
		{ name: "bare legacy id", cliModel: staleId },
		{ name: "shortened id", cliModel: "cursor-grok-4.5" },
		{ name: "case-normalized id", cliModel: exactId.toUpperCase() },
		{ name: "nearest effort", cliProvider: "cursor", cliModel: "cursor-grok-4.5-medium" },
		{ name: "reasoning suffix", cliProvider: "cursor", cliModel: `${exactId}:high` },
	] as const) {
		test(`rejects a non-exact Cursor ${entry.name} without substitution`, () => {
			const result = resolveCliModel({
				...(entry.cliProvider ? { cliProvider: entry.cliProvider } : {}),
				cliModel: entry.cliModel,
				modelRegistry: cursorRegistry(),
			});
			expect(result.model).toBeUndefined();
			expect(result.error).toContain("not found");
			expect(result.error).toContain("--list-models");
			expect(result.warning).toBeUndefined();
		});
	}

	test("bare former-legacy Cursor IDs resolve as ordinary non-Cursor rows", () => {
		const registry = cursorRegistry();
		registry.registerProvider("openai", {
			baseUrl: "https://example.invalid", apiKey: "test", api: "openai-responses",
			models: [{ ...cursorModel("composer-2"), provider: "openai", api: "openai-responses" }],
		});
		const resolved = resolveCliModel({ cliModel: "composer-2", modelRegistry: registry });
		expect(resolved.model?.provider).toBe("openai");
		expect(resolved.model?.id).toBe("composer-2");
		expect(resolved.error).toBeUndefined();

		registry.registerProvider("cursor", {
			baseUrl: "https://api2.cursor.sh", apiKey: "cursor-test-key", api: "cursor-agent",
			models: [cursorModel("composer-2")],
		});
		const current = resolveCliModel({ cliModel: "composer-2", modelRegistry: registry });
		expect(current.model?.provider).toBe("cursor");
	});

	test("explicit non-Cursor provider intent overrides rejection-only tombstones", () => {
		const registry = cursorRegistry();
		registry.registerProvider("openai", {
			baseUrl: "https://example.invalid", apiKey: "test", api: "openai-responses",
			models: [{ ...cursorModel("composer-2"), provider: "openai", api: "openai-responses" }],
		});
		expect(resolveCliModel({ cliProvider: "openai", cliModel: "composer-2", modelRegistry: registry }).model?.provider).toBe("openai");
	});

	test("scope resolution accepts only an exact Cursor reference and excludes fuzzy or glob matches", async () => {
		const registry = cursorRegistry();
		const exact = await resolveModelScopeWithDiagnostics([exactId], registry);
		expect(exact.scopedModels.map((entry) => entry.model.id)).toEqual([exactId]);
		for (const pattern of [staleId, "cursor-grok-4.5", "cursor/*", exactId.toUpperCase()]) {
			const result = await resolveModelScopeWithDiagnostics([pattern], registry);
			expect(result.scopedModels).toEqual([]);
		}
	});

	test("enabled-model scope preserves exact provider-qualified Cursor route syntax", async () => {
		const ids = ["cursor-route", "cursor-route:high", "cursor-route (1m)", " cursor-spaced ", "cursor/nested/route"];
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		registry.registerProvider("cursor", {
			baseUrl: "https://api2.cursor.sh", apiKey: "cursor-test-key", api: "cursor-agent",
			models: ids.map(cursorModel),
		});

		for (const id of ids.slice(1)) {
			const result = await resolveModelScopeWithDiagnostics([`cursor/${id}`], registry);
			expect(result.scopedModels).toHaveLength(1);
			expect(result.scopedModels[0]?.model.id).toBe(id);
			expect(result.scopedModels[0]?.thinkingLevel).toBeUndefined();
			expect(result.diagnostics).toEqual([]);
		}

		for (const pattern of ["cursor/cursor-route:medium", "cursor/cursor-route (2m)", "cursor/CURSOR-ROUTE", "cursor/cursor-*", "cursor/cursor-rou"]) {
			const result = await resolveModelScopeWithDiagnostics([pattern], registry);
			expect(result.scopedModels).toEqual([]);
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]?.type).toBe("error");
			expect(result.diagnostics[0]?.message).toContain("reselect");
		}
	});

	test("enabled-model scope resolves a bare former-legacy id as ordinary non-Cursor, then prefers an exact live Cursor route", async () => {
		const registry = cursorRegistry();
		registry.registerProvider("openai", {
			baseUrl: "https://example.invalid", apiKey: "test", api: "openai-responses",
			models: [{ ...cursorModel("composer-2"), provider: "openai", api: "openai-responses" }],
		});
		const ordinary = await resolveModelScopeWithDiagnostics(["composer-2"], registry);
		expect(ordinary.scopedModels.map((entry) => `${entry.model.provider}/${entry.model.id}`)).toEqual(["openai/composer-2"]);

		registry.registerProvider("cursor", {
			baseUrl: "https://api2.cursor.sh", apiKey: "cursor-test-key", api: "cursor-agent",
			models: [cursorModel("composer-2")],
		});
		const current = await resolveModelScopeWithDiagnostics(["composer-2"], registry);
		expect(current.scopedModels.map((entry) => `${entry.model.provider}/${entry.model.id}`)).toEqual(["cursor/composer-2"]);

		const explicitOther = await resolveModelScopeWithDiagnostics(["openai/composer-2"], registry);
		expect(explicitOther.scopedModels.map((entry) => `${entry.model.provider}/${entry.model.id}`)).toEqual(["openai/composer-2"]);
	});

	test("enabled-model scope preserves ordinary non-Cursor fuzzy and glob behavior", async () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		registry.registerProvider("anthropic", {
			baseUrl: "https://example.invalid", apiKey: "test-key", api: "anthropic-messages",
			models: [{ ...cursorModel("claude-sonnet-4-5"), provider: "anthropic", api: "anthropic-messages", name: "Claude Sonnet" }],
		});
		const result = await resolveModelScopeWithDiagnostics(["sonnet", "anthropic/*"], registry);
		expect(result.scopedModels.map((entry) => entry.model.provider)).toEqual(["anthropic"]);
	});

	test("non-Cursor fuzzy matching remains unchanged", () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		registry.registerProvider("anthropic", {
			baseUrl: "https://example.invalid", apiKey: "test-key", api: "anthropic-messages",
			models: [{ ...cursorModel("claude-sonnet-4-5"), provider: "anthropic", api: "anthropic-messages", name: "Claude Sonnet" }],
		});
		const resolved = resolveCliModel({ cliModel: "sonnet", modelRegistry: registry }).model;
		expect(resolved).toBeDefined();
		expect(resolved?.provider).not.toBe("cursor");
	});

	test("registry lookup does not honor removed compatibility metadata", () => {
		const registry = cursorRegistry();
		expect(registry.find("cursor", exactId)?.id).toBe(exactId);
		expect(registry.find("cursor", staleId)).toBeUndefined();
		expect(registry.canRestoreUnknownModel("cursor")).toBe(false);
	});

	test("a reserved lowercase cursor/ reference is terminal and never selects a case-variant or custom raw id", () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		// A custom provider literally named `Cursor` (capital) plus a custom
		// provider whose model id literally contains `cursor/missing`.
		registry.registerProvider("Cursor", {
			baseUrl: "https://custom.invalid", apiKey: "custom", api: "anthropic-messages",
			models: [{ ...cursorModel("route"), provider: "Cursor", api: "anthropic-messages" }],
		});
		registry.registerProvider("custom", {
			baseUrl: "https://custom.invalid", apiKey: "custom", api: "anthropic-messages",
			models: [{ ...cursorModel("cursor/missing"), provider: "custom", api: "anthropic-messages" }],
		});
		const all = registry.getAll();

		// Reserved lowercase `cursor/route` has no live lowercase Cursor row: terminal miss.
		expect(findExactModelReferenceMatch("cursor/route", all)).toBeUndefined();
		expect(parseModelPattern("cursor/route", all).model).toBeUndefined();
		const cliRoute = resolveCliModel({ cliModel: "cursor/route", modelRegistry: registry });
		expect(cliRoute.model).toBeUndefined();

		// Reserved lowercase `cursor/missing` must not select the custom raw id.
		expect(findExactModelReferenceMatch("cursor/missing", all)).toBeUndefined();
		expect(parseModelPattern("cursor/missing", all).model).toBeUndefined();
		expect(resolveCliModel({ cliModel: "cursor/missing", modelRegistry: registry }).model).toBeUndefined();

		// A genuine capital `Cursor/route` reference remains ordinary and resolves.
		expect(findExactModelReferenceMatch("Cursor/route", all)?.provider).toBe("Cursor");
		expect(resolveCliModel({ cliModel: "Cursor/route", modelRegistry: registry }).model?.provider).toBe("Cursor");
	});

	test("a reserved lowercase cursor/<id> still resolves when the exact live route exists", () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		registry.registerProvider("Cursor", {
			baseUrl: "https://custom.invalid", apiKey: "custom", api: "anthropic-messages",
			models: [{ ...cursorModel("route"), provider: "Cursor", api: "anthropic-messages" }],
		});
		registry.registerProvider("cursor", {
			baseUrl: "https://api2.cursor.sh", apiKey: "cursor-test-key", api: "cursor-agent",
			models: [cursorModel("route")],
		});
		const all = registry.getAll();
		expect(findExactModelReferenceMatch("cursor/route", all)?.provider).toBe("cursor");
		expect(parseModelPattern("cursor/route", all).model?.provider).toBe("cursor");
		expect(resolveCliModel({ cliModel: "cursor/route", modelRegistry: registry }).model?.provider).toBe("cursor");
	});
});
