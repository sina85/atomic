import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
	mapCursorCatalogToProviderModels,
	normalizeCursorUsableModels,
	type CursorModelCatalog,
} from "../../packages/cursor/src/model-mapper.js";

describe("Cursor exact GetUsable model mapping", () => {
	test("preserves every GetUsable row, value, occurrence, and source order", () => {
		const first = { id: " cursor-grok-4.5-high ", displayName: "Old", maxMode: false };
		const blank = { id: "", displayName: "", maxMode: true };
		const whitespace = { id: "   ", displayNameShort: "  ", maxMode: true };
		const duplicate = { id: "dup", displayName: "First", maxMode: false };
		const duplicateLater = { id: "dup", displayName: "Second", maxMode: true, supportsImages: true as const };
		const input = [first, blank, whitespace, duplicate, duplicateLater] as const;

		const models = normalizeCursorUsableModels(input);

		assert.ok(Array.isArray(models));
		assert.notEqual(models, input);
		assert.deepEqual(models, input);
		assert.equal(models[0], first);
		assert.equal(models[1], blank);
		assert.equal(models[2], whitespace);
		assert.equal(models[3], duplicate);
		assert.equal(models[4], duplicateLater);
		models.reverse();
		assert.equal(models[0], duplicateLater);
		assert.equal(input[0], first);
	});

	test("registers each exact flat route without aliases, synthesis, or a reasoning selector", () => {
		const catalog: CursorModelCatalog = {
			source: "live",
			fetchedAt: 1,
			models: [
				{ id: "cursor-grok-4.5-high", displayName: "Grok High", maxMode: true },
				{ id: "claude-sonnet-5-thinking", displayModelId: "Claude Sonnet 5", maxMode: false, supportsImages: true },
			],
		};
		const mapped = mapCursorCatalogToProviderModels(catalog);

		assert.deepEqual(mapped.map((model) => model.id), ["cursor-grok-4.5-high", "claude-sonnet-5-thinking"]);
		assert.deepEqual(mapped.map((model) => model.name), ["Grok High", "Claude Sonnet 5"]);
		assert.deepEqual(mapped.map((model) => model.reasoning), [false, false]);
		assert.deepEqual(mapped.map((model) => model.input), [["text"], ["text", "image"]]);
		assert.deepEqual(mapped[0]?.compat.cursorRouting, {
			"cursor-grok-4.5-high": {
				modelId: "cursor-grok-4.5-high", maxMode: true, supportsImages: false, catalogOccurrence: 0,
			},
		});
		assert.equal("cursorModelAliases" in (mapped[0]?.compat ?? {}), false);
		assert.equal("thinkingLevelMap" in (mapped[0] ?? {}), false);
	});

	test("maps blank, whitespace, and duplicate rows with per-ID occurrence ordinals", () => {
		const mapped = mapCursorCatalogToProviderModels({
			source: "live",
			fetchedAt: 1,
			models: [
				{ id: "", displayName: "Blank first", maxMode: false },
				{ id: "unrelated-a", maxMode: false },
				{ id: "duplicate", displayName: "First", maxMode: false },
				{ id: "   ", displayNameShort: "Whitespace first", maxMode: true },
				{ id: "unrelated-b", maxMode: true },
				{ id: "duplicate", displayName: "Second", maxMode: true, supportsImages: true },
				{ id: "", displayName: "Blank second", maxMode: true },
				{ id: "   ", displayNameShort: "Whitespace second", maxMode: false },
			],
		});

		assert.deepEqual(mapped.map((model) => model.id), [
			"", "unrelated-a", "duplicate", "   ", "unrelated-b", "duplicate", "", "   ",
		]);
		assert.deepEqual(mapped.map((model) => model.compat.cursorRouting[model.id]?.catalogOccurrence), [
			0, 0, 0, 0, 0, 1, 1, 1,
		]);
		assert.deepEqual(mapped.map((model) => model.compat.cursorRouting[model.id]), [
			{ modelId: "", maxMode: false, supportsImages: false, catalogOccurrence: 0 },
			{ modelId: "unrelated-a", maxMode: false, supportsImages: false, catalogOccurrence: 0 },
			{ modelId: "duplicate", maxMode: false, supportsImages: false, catalogOccurrence: 0 },
			{ modelId: "   ", maxMode: true, supportsImages: false, catalogOccurrence: 0 },
			{ modelId: "unrelated-b", maxMode: true, supportsImages: false, catalogOccurrence: 0 },
			{ modelId: "duplicate", maxMode: true, supportsImages: true, catalogOccurrence: 1 },
			{ modelId: "", maxMode: true, supportsImages: false, catalogOccurrence: 1 },
			{ modelId: "   ", maxMode: false, supportsImages: false, catalogOccurrence: 1 },
		]);
	});
});
