import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { resolveFallbackModel } from "../src/core/agent-session-retry.ts";

const makeModel = (provider: string, id: string): Model<Api> => ({
	...getModel("anthropic", "claude-sonnet-4-5")!,
	provider,
	id,
	name: `${provider}/${id}`,
}) as Model<Api>;

function resolve(value: string, models: Model<Api>[]) {
	return resolveFallbackModel.call({
		_modelRegistry: {
			getAvailable: () => models,
			hasConfiguredAuth: () => true,
		},
		model: undefined,
		settingsManager: { getDefaultProvider: () => undefined },
	} as unknown as AgentSession, value);
}

describe("fallback model reference preservation", () => {
	it("tries raw exact Cursor routes before suffix parsing", () => {
		const suffix = makeModel("cursor", "route:high");
		const spaced = makeModel("cursor", " route ");
		expect(resolve("cursor/route:high", [makeModel("cursor", "route"), suffix])).toEqual({
			model: suffix,
			thinkingLevel: undefined,
		});
		expect(resolve("cursor/ route ", [spaced])?.model).toBe(spaced);
	});

	it("never rewrites a missing exact Cursor fallback to another Cursor route", () => {
		expect(resolve("cursor/route:high", [makeModel("cursor", "route")])).toBeUndefined();
	});

	it("retains generic non-Cursor trimming, suffixes, and custom Cursor providers", () => {
		const openai = makeModel("openai", "gpt-4o");
		const customCursor = makeModel("Cursor", "route");
		expect(resolve(" openai/gpt-4o:high ", [openai])).toEqual({ model: openai, thinkingLevel: "high" });
		expect(resolve("Cursor/route", [customCursor, makeModel("cursor", "route")])?.model).toBe(customCursor);
	});
});
