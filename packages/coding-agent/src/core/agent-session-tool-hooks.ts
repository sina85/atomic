import type { AgentContext, AgentLoopTurnUpdate } from "@earendil-works/pi-agent-core";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { redirectOversizedToolResult } from "./tools/oversized-tool-result.js";

export function _installAgentToolHooks(this: AgentSession): void {
	this.agent.beforeToolCall = async ({ toolCall, args }) => {
		const runner = this._extensionRunner;
		if (!runner.hasHandlers("tool_call")) {
			return undefined;
		}

		await this._agentEventQueue;

		try {
			return await runner.emitToolCall({
				type: "tool_call",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
			});
		} catch (err) {
			if (err instanceof Error) {
				throw err;
			}
			throw new Error(`Extension failed, blocking execution: ${String(err)}`);
		}
	};

	this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
		const runner = this._extensionRunner;
		const hookResult = runner.hasHandlers("tool_result")
			? await runner.emitToolResult({
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					isError,
				})
			: undefined;

		const extensionReplacement = hookResult
			? {
					content: hookResult.content,
					details: hookResult.details,
					isError: hookResult.isError ?? isError,
				}
			: undefined;
		const finalResult = hookResult
			? {
					content: hookResult.content ?? result.content,
					// Preserve original details when an extension hook rewrites only content;
					// the redirect check only replaces model-visible content blocks.
					details: hookResult.details ?? result.details,
				}
			: result;
		const finalIsError = hookResult?.isError ?? isError;
		const redirectReplacement = await redirectOversizedToolResult({
			toolName: toolCall.name,
			toolCallId: toolCall.id,
			result: finalResult,
			isError: finalIsError,
			sessionId: this.sessionManager.getSessionId(),
			sessionDir: this.sessionManager.getSessionDir() || undefined,
			maxResultSizeChars: this.getToolDefinition(toolCall.name)?.maxResultSizeChars,
		});

		return redirectReplacement ?? extensionReplacement;
	};
}

/**
 * Install a prepareNextTurn hook so that extension tool changes
 * (e.g. setActiveTools) and before_agent_start systemPrompt overrides are
 * applied to the next provider request within the same run.
 */
export function _installAgentNextTurnRefresh(this: AgentSession): void {
	const previousPrepareNextTurn = this.agent.prepareNextTurn;
	this.agent.prepareNextTurn = async (signal?: AbortSignal): Promise<AgentLoopTurnUpdate> => {
		const previousSnapshot = await previousPrepareNextTurn?.call(this.agent, signal);
		const previousContext: AgentContext = previousSnapshot?.context ?? {
			systemPrompt: this.agent.state.systemPrompt,
			messages: this.agent.state.messages.slice(),
			tools: this.agent.state.tools.slice(),
		};

		return {
			...previousSnapshot,
			context: {
				...previousContext,
				systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
				tools: this.agent.state.tools.slice(),
			},
			model: this.agent.state.model,
			thinkingLevel: this.agent.state.thinkingLevel,
		};
	};
}

export const agentSessionToolHooksMethods = {
	_installAgentToolHooks,
	_installAgentNextTurnRefresh,
};
