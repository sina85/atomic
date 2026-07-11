export interface AssistantTurnEntry {
	entryId: string;
	role: string;
	hasSignedThinking: boolean;
	startsNewTurn: boolean;
}

export interface AssistantToolUseTurn {
	entryIds: string[];
	assistantEntryIds: string[];
	signedThinkingEntryIds: string[];
	active: boolean;
}

/**
 * Analyze chronological LLM-visible entries as logical assistant tool-use turns.
 * Callers adapt each context-visible user-like message into `startsNewTurn`;
 * tool results remain in the current turn. The final logical turn is active,
 * even when its current input has not received an assistant reply.
 */
export function analyzeAssistantToolUseTurns(entries: readonly AssistantTurnEntry[]): AssistantToolUseTurn[] {
	const groups: Array<Omit<AssistantToolUseTurn, "active">> = [];
	let current: Omit<AssistantToolUseTurn, "active"> | undefined;

	for (const entry of entries) {
		if (entry.startsNewTurn || current === undefined) {
			current = { entryIds: [], assistantEntryIds: [], signedThinkingEntryIds: [] };
			groups.push(current);
		}
		current.entryIds.push(entry.entryId);
		if (entry.role !== "assistant") continue;
		current.assistantEntryIds.push(entry.entryId);
		if (entry.hasSignedThinking) current.signedThinkingEntryIds.push(entry.entryId);
	}

	const activeIndex = groups.length - 1;
	return groups
		.map((turn, index) => ({ ...turn, active: index === activeIndex }))
		.filter((turn) => turn.assistantEntryIds.length > 0);
}
