import type { ContextDeletionTarget } from "../session-manager.ts";
import type { CompactableTranscript, ValidatedContextDeletionResult } from "./context-compaction-types.ts";
import { reconcileToolDependencies, validateContextDeletionRequest } from "./context-deletion-application.ts";
import {
	canDeleteTarget,
	deletionRequestFromTargets,
	getDeletedContentBlocks,
	getDeletedEntryIds,
	isTranscriptEntryEffectivelyDeleted,
	transcriptEntryStartsNewTurn,
} from "./context-deletion-targets.ts";
import { relaxTranscriptForCriticalEviction } from "./context-compaction-critical.ts";
import { assistantEntryHasThinkingContentBlock } from "./context-transcript-analysis.ts";
import { analyzeAssistantToolUseTurns } from "./context-assistant-turns.js";

export const CONTEXT_COMPACTION_MAX_EVICTION_PASSES = 50;

interface EvictionGroup {
	entryIds: string[];
	order: number;
	tokens: number;
	boundary: boolean;
}

function terminalDeterministicEvictionError(
	reason: string,
	lastValidated: ValidatedContextDeletionResult | undefined,
	tokenBudget: number,
): Error {
	const statsText = lastValidated
		? `achieved tokensAfter=${lastValidated.stats.tokensAfter}, reduction=${lastValidated.stats.percentReduction}%, deletionTargets=${lastValidated.deletedTargets.length}`
		: "achieved no validated deletion targets";
	return new Error(
		`Context deterministic overflow eviction failed: ${reason}; ${statsText}; budget=${tokenBudget}; nothing more was safely deletable`,
	);
}

function hasFitBudget(result: ValidatedContextDeletionResult | undefined, tokenBudget: number): result is ValidatedContextDeletionResult {
	return result !== undefined && result.deletedTargets.length > 0 && result.stats.tokensAfter <= tokenBudget;
}

function assistantTurnsForTargets(
	transcript: CompactableTranscript,
	targets: readonly ContextDeletionTarget[],
) {
	const deletedEntryIds = getDeletedEntryIds(targets);
	const deletedContentBlocks = getDeletedContentBlocks(targets);
	return analyzeAssistantToolUseTurns(
		transcript.entries.map((entry) => ({
			entryId: entry.entryId,
			role: entry.role,
			hasSignedThinking: assistantEntryHasThinkingContentBlock(entry),
			startsNewTurn:
				!isTranscriptEntryEffectivelyDeleted(entry, deletedEntryIds, deletedContentBlocks) &&
				transcriptEntryStartsNewTurn(entry, deletedContentBlocks.get(entry.entryId)),
		})),
	);
}

function repairSignedTurnTargets(
	transcript: CompactableTranscript,
	targets: readonly ContextDeletionTarget[],
): ContextDeletionTarget[] {
	const reconciled = reconcileToolDependencies(transcript, targets);
	const deletedEntryIds = getDeletedEntryIds(reconciled);
	const restoredSignedIds = new Set<string>();
	for (const turn of assistantTurnsForTargets(transcript, reconciled)) {
		const deleted = turn.signedThinkingEntryIds.filter((entryId) => deletedEntryIds.has(entryId));
		if (deleted.length === 0) continue;
		if (!turn.active && deleted.length === turn.signedThinkingEntryIds.length) continue;
		for (const entryId of turn.signedThinkingEntryIds) restoredSignedIds.add(entryId);
	}
	if (restoredSignedIds.size === 0) return reconciled;

	const restoredCallIds = new Set<string>();
	for (const entry of transcript.entries) {
		if (!restoredSignedIds.has(entry.entryId)) continue;
		for (const callId of entry.toolCallIds) restoredCallIds.add(callId);
	}
	const restoredResultIds = new Set(
		transcript.entries
			.filter((entry) => entry.toolResultFor && restoredCallIds.has(entry.toolResultFor))
			.map((entry) => entry.entryId),
	);
	return reconcileToolDependencies(
		transcript,
		reconciled.filter((target) => !restoredSignedIds.has(target.entryId) && !restoredResultIds.has(target.entryId)),
	);
}

function targetsWithGroup(
	planned: readonly ContextDeletionTarget[],
	entryIds: readonly string[],
): ContextDeletionTarget[] {
	const deleted = getDeletedEntryIds(planned);
	return [
		...planned,
		...entryIds
			.filter((entryId) => !deleted.has(entryId))
			.map((entryId): ContextDeletionTarget => ({ kind: "entry", entryId })),
	];
}

function validateTargets(
	transcript: CompactableTranscript,
	targets: readonly ContextDeletionTarget[],
): ValidatedContextDeletionResult | undefined {
	try {
		const result = validateContextDeletionRequest(deletionRequestFromTargets(targets), transcript);
		const order = new Map(transcript.entries.map((entry, index) => [entry.entryId, index]));
		return {
			...result,
			deletedTargets: [...result.deletedTargets].sort((left, right) => {
				const entryDelta =
					(order.get(left.entryId) ?? Number.MAX_SAFE_INTEGER) -
					(order.get(right.entryId) ?? Number.MAX_SAFE_INTEGER);
				if (entryDelta !== 0) return entryDelta;
				const leftBlock = left.kind === "content_block" ? left.blockIndex : -1;
				const rightBlock = right.kind === "content_block" ? right.blockIndex : -1;
				return leftBlock - rightBlock;
			}),
		};
	} catch {
		return undefined;
	}
}

function initialEvictionGroups(transcript: CompactableTranscript): EvictionGroup[] {
	const turns = assistantTurnsForTargets(transcript, []);
	const signedGroupByEntryId = new Map<string, string[]>();
	const activeSignedIds = new Set<string>();
	for (const turn of turns) {
		if (turn.active) {
			for (const entryId of turn.signedThinkingEntryIds) activeSignedIds.add(entryId);
			continue;
		}
		for (const entryId of turn.signedThinkingEntryIds) {
			signedGroupByEntryId.set(entryId, turn.signedThinkingEntryIds);
		}
	}

	const entryById = new Map(transcript.entries.map((entry, index) => [entry.entryId, { entry, index }]));
	const grouped = new Set<string>();
	const groups: EvictionGroup[] = [];
	for (let index = 0; index < transcript.entries.length; index++) {
		const entry = transcript.entries[index]!;
		if (activeSignedIds.has(entry.entryId) || grouped.has(entry.entryId)) continue;
		const entryIds = signedGroupByEntryId.get(entry.entryId) ?? [entry.entryId];
		for (const entryId of entryIds) grouped.add(entryId);
		if (!entryIds.every((entryId) => canDeleteTarget(transcript, { kind: "entry", entryId }))) continue;
		groups.push({
			entryIds: [...entryIds],
			order: index,
			tokens: entryIds.reduce((sum, entryId) => sum + (entryById.get(entryId)?.entry.tokenEstimate ?? 0), 0),
			boundary: entryIds.length === 1 && transcriptEntryStartsNewTurn(entry),
		});
	}
	return groups;
}

function repairedFittingBoundaryPrefix(
	transcript: CompactableTranscript,
	planned: readonly ContextDeletionTarget[],
	groups: readonly EvictionGroup[],
	tokenBudget: number,
	currentTokens: number,
): ValidatedContextDeletionResult | undefined {
	const required = currentTokens - tokenBudget;
	if (required <= 0) return undefined;
	let rawRemoved = 0;
	let lowerBound = 0;
	while (lowerBound < groups.length && rawRemoved < required) {
		rawRemoved += groups[lowerBound]!.tokens;
		lowerBound += 1;
	}
	if (rawRemoved < required) return undefined;

	let prospective = [...planned];
	for (let index = 0; index < groups.length; index++) {
		prospective = targetsWithGroup(prospective, groups[index]!.entryIds);
		if (index + 1 < lowerBound) continue;
		const repaired = repairSignedTurnTargets(transcript, prospective);
		const validated = validateTargets(transcript, repaired);
		if (!validated || !hasFitBudget(validated, tokenBudget)) continue;
		const deleted = getDeletedEntryIds(validated.deletedTargets);
		const prefixRetained = groups
			.slice(0, index + 1)
			.some((group) => group.entryIds.some((entryId) => !deleted.has(entryId)));
		if (!prefixRetained) return validated;
	}
	return undefined;
}

function adoptSmallestFittingPrefix(
	transcript: CompactableTranscript,
	planned: readonly ContextDeletionTarget[],
	groups: readonly EvictionGroup[],
	tokenBudget: number,
): ValidatedContextDeletionResult | undefined {
	if (groups.length === 0) return undefined;
	const prefixTargets = (count: number): ContextDeletionTarget[] =>
		groups.slice(0, count).reduce((targets, group) => targetsWithGroup(targets, group.entryIds), [...planned]);
	const full = validateTargets(transcript, prefixTargets(groups.length));
	if (!full) return undefined;
	if (!hasFitBudget(full, tokenBudget)) return full;

	let low = 1;
	let high = groups.length;
	let best = full;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const result = validateTargets(transcript, prefixTargets(middle));
		if (result && hasFitBudget(result, tokenBudget)) {
			best = result;
			high = middle - 1;
		} else {
			low = middle + 1;
		}
	}
	return best;
}

function tryGroup(
	transcript: CompactableTranscript,
	planned: readonly ContextDeletionTarget[],
	group: EvictionGroup,
	repairBoundary: boolean,
): ValidatedContextDeletionResult | undefined {
	const directTargets = targetsWithGroup(planned, group.entryIds);
	const direct = validateTargets(transcript, directTargets);
	if (direct) return direct;
	if (!repairBoundary) return undefined;
	const repaired = repairSignedTurnTargets(transcript, directTargets);
	const result = validateTargets(transcript, repaired);
	if (!result) return undefined;
	const deleted = getDeletedEntryIds(result.deletedTargets);
	return group.entryIds.every((entryId) => deleted.has(entryId)) ? result : undefined;
}

function currentHistoricalSignedGroups(
	transcript: CompactableTranscript,
	planned: readonly ContextDeletionTarget[],
): EvictionGroup[] {
	const deleted = getDeletedEntryIds(planned);
	const order = new Map(transcript.entries.map((entry, index) => [entry.entryId, index]));
	const tokens = new Map(transcript.entries.map((entry) => [entry.entryId, entry.tokenEstimate]));
	return assistantTurnsForTargets(transcript, planned)
		.filter((turn) => !turn.active)
		.map((turn) => turn.signedThinkingEntryIds.filter((entryId) => !deleted.has(entryId)))
		.filter((entryIds) => entryIds.length > 0)
		.filter((entryIds) => entryIds.every((entryId) => canDeleteTarget(transcript, { kind: "entry", entryId })))
		.map((entryIds) => ({
			entryIds,
			order: order.get(entryIds[0]!) ?? Number.MAX_SAFE_INTEGER,
			tokens: entryIds.reduce((sum, entryId) => sum + (tokens.get(entryId) ?? 0), 0),
			boundary: false,
		}));
}

function targetIdentity(target: ContextDeletionTarget): string {
	return target.kind === "entry"
		? `entry:${target.entryId}`
		: `content_block:${target.entryId}:${target.blockIndex}`;
}

function boundaryRestorationSignature(
	transcript: CompactableTranscript,
	planned: readonly ContextDeletionTarget[],
	group: EvictionGroup,
): string | undefined {
	try {
		const repaired = repairSignedTurnTargets(transcript, targetsWithGroup(planned, group.entryIds));
		const retainedKeys = new Set(repaired.map(targetIdentity));
		const restoredKeys = planned
			.map(targetIdentity)
			.filter((key) => !retainedKeys.has(key))
			.sort();
		return restoredKeys.length > 0 ? restoredKeys.join("|") : undefined;
	} catch {
		return undefined;
	}
}

function skippedBoundaryRestorationGroups(
	transcript: CompactableTranscript,
	planned: readonly ContextDeletionTarget[],
	skipped: readonly EvictionGroup[],
): EvictionGroup[][] {
	const bySignature = new Map<string, EvictionGroup[]>();
	for (const group of skipped) {
		const signature = boundaryRestorationSignature(transcript, planned, group);
		if (!signature) continue;
		const matches = bySignature.get(signature) ?? [];
		matches.push(group);
		bySignature.set(signature, matches);
	}
	return [...bySignature.values()].filter((groups) => groups.length > 1);
}

interface AlternateBoundaryState {
	targets: ContextDeletionTarget[];
	tokensAfter: number;
	signature: string;
}

function deletionPlanSignature(targets: readonly ContextDeletionTarget[]): string {
	return targets.map(targetIdentity).sort().join("|");
}

function retainBoundedAlternateStates(states: readonly AlternateBoundaryState[]): AlternateBoundaryState[] {
	const deduplicated = [...new Map(states.map((state) => [state.signature, state])).values()].sort(
		(left, right) => left.tokensAfter - right.tokensAfter || left.signature.localeCompare(right.signature),
	);
	// Keep the fallback linear in boundary count while retaining both near-fit
	// plans and less-committed plans that can preserve different turn topology.
	const limit = 16;
	if (deduplicated.length <= limit) return deduplicated;

	const retained: AlternateBoundaryState[] = [];
	for (let index = 0; index < limit / 2; index++) {
		retained.push(deduplicated[index]!, deduplicated[deduplicated.length - 1 - index]!);
	}
	return retained.sort(
		(left, right) => left.tokensAfter - right.tokensAfter || left.signature.localeCompare(right.signature),
	);
}

function alternateBoundaryPlan(
	transcript: CompactableTranscript,
	initialTargets: readonly ContextDeletionTarget[],
	initialResult: ValidatedContextDeletionResult | undefined,
	groups: readonly EvictionGroup[],
	tokenBudget: number,
): ValidatedContextDeletionResult | undefined {
	let states: AlternateBoundaryState[] = [{
		targets: [...initialTargets],
		tokensAfter: initialResult?.stats.tokensAfter ?? transcript.tokensBefore,
		signature: deletionPlanSignature(initialTargets),
	}];

	for (const group of groups) {
		const expanded = [...states];
		let fitting: ValidatedContextDeletionResult | undefined;
		for (const state of states) {
			const result = tryGroup(transcript, state.targets, group, true);
			if (!result) continue;
			if (result.deletedTargets.length > 0 && result.stats.tokensAfter <= tokenBudget) {
				if (!fitting || result.stats.tokensAfter > fitting.stats.tokensAfter) fitting = result;
				continue;
			}
			expanded.push({
				targets: [...result.deletedTargets],
				tokensAfter: result.stats.tokensAfter,
				signature: deletionPlanSignature(result.deletedTargets),
			});
		}
		if (fitting) return fitting;
		states = retainBoundedAlternateStates(expanded);
	}

	for (const state of states) {
		let targets = state.targets;
		for (const group of currentHistoricalSignedGroups(transcript, targets)) {
			const result = tryGroup(transcript, targets, group, false);
			if (!result) continue;
			targets = [...result.deletedTargets];
			if (hasFitBudget(result, tokenBudget)) return result;
		}
	}
	return undefined;
}

export function runDeterministicContextEviction(
	transcript: CompactableTranscript,
	tokenBudget: number,
): ValidatedContextDeletionResult {
	const relaxed = relaxTranscriptForCriticalEviction(transcript);
	const groups = initialEvictionGroups(relaxed);
	const nonBoundaries = groups.filter((group) => !group.boundary).sort((left, right) => left.order - right.order);
	const boundaries = groups
		.filter((group) => group.boundary)
		.sort((left, right) => right.tokens - left.tokens || left.order - right.order);
	let planned: ContextDeletionTarget[] = [];
	let lastValidated: ValidatedContextDeletionResult | undefined;
	const skippedBoundaries: EvictionGroup[] = [];

	if (relaxed.tokensBefore > tokenBudget) {
		const batch = adoptSmallestFittingPrefix(relaxed, planned, nonBoundaries, tokenBudget);
		if (batch) {
			planned = [...batch.deletedTargets];
			lastValidated = batch;
			if (hasFitBudget(lastValidated, tokenBudget)) return lastValidated;
		} else {
			for (const group of nonBoundaries) {
				const result = tryGroup(relaxed, planned, group, false);
				if (!result) continue;
				planned = [...result.deletedTargets];
				lastValidated = result;
				if (hasFitBudget(lastValidated, tokenBudget)) return lastValidated;
			}
		}
	} else {
		for (const group of nonBoundaries) {
			const result = tryGroup(relaxed, planned, group, false);
			if (!result) continue;
			return result;
		}
	}

	const boundaryBaseTargets = [...planned];
	const boundaryBaseResult = lastValidated;
	const boundaryBatch = repairedFittingBoundaryPrefix(
		relaxed,
		planned,
		boundaries,
		tokenBudget,
		lastValidated?.stats.tokensAfter ?? relaxed.tokensBefore,
	);
	if (boundaryBatch) {
		const standalone = boundaries[0] ? tryGroup(relaxed, [], boundaries[0], true) : undefined;
		return standalone && hasFitBudget(standalone, tokenBudget) && standalone.stats.tokensAfter > boundaryBatch.stats.tokensAfter
			? standalone
			: boundaryBatch;
	}

	for (const group of boundaries) {
		const result = tryGroup(relaxed, planned, group, true);
		if (!result || (lastValidated && result.stats.tokensAfter >= lastValidated.stats.tokensAfter)) {
			skippedBoundaries.push(group);
			continue;
		}
		planned = [...result.deletedTargets];
		lastValidated = result;
		if (hasFitBudget(lastValidated, tokenBudget)) {
			const standalone = tryGroup(relaxed, [], group, true);
			return standalone && hasFitBudget(standalone, tokenBudget) && standalone.stats.tokensAfter > result.stats.tokensAfter
				? standalone
				: result;
		}
	}

	for (const group of currentHistoricalSignedGroups(relaxed, planned)) {
		const result = tryGroup(relaxed, planned, group, false);
		if (!result) continue;
		planned = [...result.deletedTargets];
		lastValidated = result;
		if (hasFitBudget(lastValidated, tokenBudget)) return lastValidated;
	}

	const groupedRetryIds = new Set<string>();
	for (const component of skippedBoundaryRestorationGroups(relaxed, planned, skippedBoundaries)) {
		const entryIds = component.flatMap((group) => group.entryIds);
		for (const entryId of entryIds) groupedRetryIds.add(entryId);
		const combined: EvictionGroup = {
			entryIds,
			order: Math.min(...component.map((group) => group.order)),
			tokens: component.reduce((sum, group) => sum + group.tokens, 0),
			boundary: true,
		};
		const result = tryGroup(relaxed, planned, combined, true);
		if (!result) continue;
		const deleted = getDeletedEntryIds(result.deletedTargets);
		if (!entryIds.every((entryId) => deleted.has(entryId))) continue;
		if (lastValidated && result.stats.tokensAfter >= lastValidated.stats.tokensAfter && !hasFitBudget(result, tokenBudget)) {
			continue;
		}
		planned = [...result.deletedTargets];
		lastValidated = result;
		if (hasFitBudget(lastValidated, tokenBudget)) return lastValidated;
	}

	for (const group of skippedBoundaries) {
		if (group.entryIds.some((entryId) => groupedRetryIds.has(entryId))) continue;
		const result = tryGroup(relaxed, planned, group, true);
		if (!result || (lastValidated && result.stats.tokensAfter >= lastValidated.stats.tokensAfter)) continue;
		planned = [...result.deletedTargets];
		lastValidated = result;
		if (hasFitBudget(lastValidated, tokenBudget)) return lastValidated;
	}

	const alternate = alternateBoundaryPlan(
		relaxed,
		boundaryBaseTargets,
		boundaryBaseResult,
		boundaries,
		tokenBudget,
	);
	if (alternate) return alternate;

	throw terminalDeterministicEvictionError("candidate sweep exhausted", lastValidated, tokenBudget);
}
