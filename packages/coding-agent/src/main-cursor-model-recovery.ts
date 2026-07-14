import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { isValidThinkingLevel, type Args } from "./cli/args.ts";
import type { AgentSessionRuntime } from "./core/agent-session-runtime.ts";
import type { AgentSessionRuntimeDiagnostic } from "./core/agent-session-services.ts";
import { findModelAliasThinkingLevel } from "./core/model-id-aliases.ts";
import type { ModelRegistry } from "./core/model-registry.ts";
import { findExactModelReferenceMatch, resolveCliModel } from "./core/model-resolver.ts";
import type { AppMode } from "./main-app-mode.ts";
import { bindExtensionsForModelDiscovery } from "./main-stdio.ts";

interface CursorModelRecoverySession {
	setModel(model: Model<Api>): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): void;
	setContextWindow(contextWindow: number, options?: { persistDefault?: boolean }): void;
}

export interface CursorModelRecoveryOptions {
	readonly cliProvider?: string;
	readonly cliModel?: string;
	readonly cliThinking?: ThinkingLevel;
	readonly cliContextWindow?: number;
	readonly diagnostics: readonly AgentSessionRuntimeDiagnostic[];
	readonly modelRegistry: ModelRegistry;
	readonly session: CursorModelRecoverySession;
	readonly discoverModels: () => Promise<void>;
}

/** Resolve a Cursor CLI reference only after authenticated discovery, without fuzzy substitution. */
export function recoverCursorCliModelAfterExtensionStartup(
	parsed: Pick<Args, "provider" | "model" | "thinking" | "contextWindow">,
	runtime: AgentSessionRuntime,
	appMode: AppMode,
): Promise<readonly AgentSessionRuntimeDiagnostic[]> {
	return recoverUnresolvedCursorCliModel({
		cliProvider: parsed.provider,
		cliModel: parsed.model,
		cliThinking: parsed.thinking,
		cliContextWindow: parsed.contextWindow,
		diagnostics: runtime.diagnostics,
		modelRegistry: runtime.services.modelRegistry,
		session: runtime.session,
		discoverModels: () => bindExtensionsForModelDiscovery(runtime, extensionModeForAppMode(appMode)),
	});
}

export async function recoverUnresolvedCursorCliModel(
	options: CursorModelRecoveryOptions,
): Promise<readonly AgentSessionRuntimeDiagnostic[]> {
	if (!isCursorSelection(options.cliProvider, options.cliModel)) return options.diagnostics;

	const initial = resolveCliModel({
		cliProvider: options.cliProvider,
		cliModel: options.cliModel!,
		modelRegistry: options.modelRegistry,
	});
	await options.discoverModels();
	const reference = normalizeCursorReference(options.cliProvider, options.cliModel!);
	const resolved = findExactCursorModel(reference, options.modelRegistry.getAll());
	const diagnosticsWithoutInitialError = initial.error
		? options.diagnostics.filter((diagnostic) => diagnostic.message !== initial.error)
		: options.diagnostics;
	if (!resolved) {
		const error = initial.error ?? `Model "${reference}" not found. Use --list-models to see available models.`;
		return diagnosticsWithoutInitialError.some((diagnostic) => diagnostic.type === "error" && diagnostic.message === error)
			? diagnosticsWithoutInitialError
			: [...diagnosticsWithoutInitialError, { type: "error", message: error }];
	}

	await options.session.setModel(resolved.model);
	const thinkingLevel = options.cliThinking ?? resolved.thinkingLevel;
	if (thinkingLevel) options.session.setThinkingLevel(thinkingLevel);
	if (options.cliContextWindow !== undefined) {
		try {
			options.session.setContextWindow(options.cliContextWindow, { persistDefault: true });
		} catch (error) {
			return [...diagnosticsWithoutInitialError, {
				type: "error",
				message: error instanceof Error ? error.message : String(error),
			}];
		}
	}
	return diagnosticsWithoutInitialError;
}

function isCursorSelection(provider: string | undefined, model: string | undefined): boolean {
	if (!model) return false;
	if (provider?.trim().toLowerCase() === "cursor") return true;
	const slashIndex = model.indexOf("/");
	return slashIndex > 0 && model.slice(0, slashIndex).trim().toLowerCase() === "cursor";
}

function normalizeCursorReference(provider: string | undefined, model: string): string {
	const trimmedModel = model.trim();
	const slashIndex = trimmedModel.indexOf("/");
	if (slashIndex > 0 && trimmedModel.slice(0, slashIndex).trim().toLowerCase() === "cursor") {
		return `cursor/${trimmedModel.slice(slashIndex + 1).trim()}`;
	}
	return provider?.trim().toLowerCase() === "cursor" ? `cursor/${trimmedModel}` : trimmedModel;
}

function findExactCursorModel(
	reference: string,
	availableModels: Model<Api>[],
): { readonly model: Model<Api>; readonly thinkingLevel?: ThinkingLevel } | undefined {
	const direct = findExactModelReferenceMatch(reference, availableModels);
	if (direct?.provider.toLowerCase() === "cursor") {
		return { model: direct, thinkingLevel: aliasThinkingLevel(direct, reference) };
	}

	const colonIndex = reference.lastIndexOf(":");
	if (colonIndex <= 0) return undefined;
	const suffix = reference.slice(colonIndex + 1);
	if (!isValidThinkingLevel(suffix)) return undefined;
	const withoutThinking = reference.slice(0, colonIndex);
	const matched = findExactModelReferenceMatch(withoutThinking, availableModels);
	return matched?.provider.toLowerCase() === "cursor"
		? { model: matched, thinkingLevel: suffix }
		: undefined;
}

function aliasThinkingLevel(model: Model<Api>, reference: string): ThinkingLevel | undefined {
	const slashIndex = reference.indexOf("/");
	const aliasId = slashIndex >= 0 ? reference.slice(slashIndex + 1) : reference;
	return findModelAliasThinkingLevel(model, aliasId);
}

function extensionModeForAppMode(appMode: AppMode): "tui" | "print" | "json" | "rpc" {
	return appMode === "interactive" ? "tui" : appMode;
}
