import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "../src/core/messages.ts";
import {
	assistantText,
	buildSessionContext,
	contextEntry,
	DEFAULT_COMPACTION_SETTINGS,
	entry,
	prepareContextCompaction,
	resetIds,
	type SessionEntry,
	user,
	validateContextDeletionRequest,
} from "./context-compaction-helpers.js";

function signed(signature: string): AssistantMessage {
	return {
		...assistantText(""),
		content: [{ type: "thinking", thinking: signature, thinkingSignature: signature }],
	} as AssistantMessage;
}

function custom(content: string | (TextContent | ImageContent)[]): AgentMessage {
	return {
		role: "custom",
		customType: "visibility-test",
		content,
		display: true,
		timestamp: Date.now(),
	} as AgentMessage;
}

function branchSummary(summary: string): SessionEntry {
	return {
		type: "branch_summary",
		id: `summary-${Math.random()}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		fromId: "old-branch",
		summary,
	} as SessionEntry;
}

function relink(entries: SessionEntry[]): SessionEntry[] {
	entries.forEach((item, index) => {
		item.parentId = index === 0 ? null : entries[index - 1]!.id;
	});
	return entries;
}

function invisibleBoundaries(): Array<() => SessionEntry> {
	return [
		() => entry({ role: "user", content: [], timestamp: Date.now() }),
		() => entry(user("  \n\t")),
		() => entry({ role: "user", content: null, timestamp: Date.now() } as never),
		() => entry({ role: "user", content: [{ type: "text", text: "  \n " }], timestamp: Date.now() }),
		() => entry(custom("   ")),
		() => entry(custom([])),
		() => branchSummary(""),
	];
}

describe("provider-visible signed-turn boundaries", () => {
	it("fresh validation ignores empty and whitespace-only user-like inputs", () => {
		for (const makeBoundary of invisibleBoundaries()) {
			resetIds();
			const first = entry(signed("sig-first"));
			const second = entry(signed("sig-second"));
			const entries = relink([
				entry(user("historical task")),
				first,
				makeBoundary(),
				second,
				entry(user("current task")),
			]);
			const transcript = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 })!.transcript;
			expect(() =>
				validateContextDeletionRequest({ deletions: [{ kind: "entry", entryId: first.id }] }, transcript),
			).toThrow(/completed assistant tool-use turn.*retain all or omit all/);
		}
	});

	it("persisted repair follows final LLM visibility and remains non-destructive", () => {
		for (const makeBoundary of invisibleBoundaries()) {
			resetIds();
			const first = entry(signed("sig-persisted-first"));
			const second = entry(signed("sig-persisted-second"));
			const branch = relink([
				entry(user("historical task")),
				first,
				makeBoundary(),
				second,
				contextEntry([{ kind: "entry", entryId: first.id }]),
				entry(user("current task")),
			]);
			const durable = JSON.stringify(branch);
			const llm = convertToLlm(buildSessionContext(branch).messages);
			const serialized = JSON.stringify(llm);
			expect(serialized).toContain("sig-persisted-first");
			expect(serialized).toContain("sig-persisted-second");
			expect(JSON.stringify(branch)).toBe(durable);
		}
	});

	it("treats filtering the only visible custom block as removing the boundary", () => {
		resetIds();
		const first = entry(signed("sig-filtered-boundary-first"));
		const boundary = entry(custom([
			{ type: "text", text: "visible boundary" },
			{ type: "text", text: "   " },
		]));
		const second = entry(signed("sig-filtered-boundary-second"));
		const base = relink([entry(user("first task")), first, boundary, second, entry(user("current task"))]);
		const transcript = prepareContextCompaction(base, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 })!.transcript;
		const boundaryEntry = transcript.entries.find((candidate) => candidate.entryId === boundary.id)!;
		boundaryEntry.protected = false;
		boundaryEntry.contentBlocks.forEach((block) => (block.protected = false));
		expect(() =>
			validateContextDeletionRequest(
				{
					deletions: [
						{ kind: "content_block", entryId: boundary.id, blockIndex: 0 },
						{ kind: "entry", entryId: first.id },
					],
				},
				transcript,
			),
		).toThrow(/completed assistant tool-use turn.*retain all or omit all/);

		const persisted = relink([
			...base.slice(0, -1),
			contextEntry([
				{ kind: "content_block", entryId: boundary.id, blockIndex: 0 },
				{ kind: "entry", entryId: first.id },
			]),
			entry(user("current task")),
		]);
		expect(JSON.stringify(convertToLlm(buildSessionContext(persisted).messages))).toContain("sig-filtered-boundary-first");
	});
	it("keeps image inputs and whitespace branch summaries as visible boundaries", () => {
		const visibleBoundaries: Array<() => SessionEntry> = [
			() => entry({ role: "user", content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }], timestamp: Date.now() }),
			() => branchSummary("   "),
		];
		for (const makeBoundary of visibleBoundaries) {
			resetIds();
			const first = entry(signed("sig-visible-first"));
			const entries = relink([
				entry(user("first task")),
				first,
				makeBoundary(),
				entry(signed("sig-visible-second")),
				entry(user("current task")),
			]);
			const transcript = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 })!.transcript;
			expect(
				validateContextDeletionRequest({ deletions: [{ kind: "entry", entryId: first.id }] }, transcript).deletedTargets,
			).toContainEqual({ kind: "entry", entryId: first.id });
		}
	});

	it("convertToLlm emits exactly the same user-like boundaries used by turn analysis", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: [], timestamp: 1 },
			{ role: "user", content: [{ type: "text", text: "   " }], timestamp: 2 },
			custom(""),
			custom([{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }]),
			{ role: "branchSummary", summary: "", fromId: "a", timestamp: 3 },
			{ role: "branchSummary", summary: " ", fromId: "b", timestamp: 4 },
		];
		const converted = convertToLlm(messages);
		expect(converted).toHaveLength(2);
		expect(JSON.stringify(converted[0])).toContain("image");
		expect(JSON.stringify(converted[1])).toContain("<summary>");
	});
});
