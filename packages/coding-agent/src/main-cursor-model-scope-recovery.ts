import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { modelsAreEqual } from "@earendil-works/pi-ai/compat";
import type { ExtensionMode } from "./core/extensions/context-types.ts";
import { parseExactCursorProviderReference } from "./core/cursor-model-reference.ts";
import type { ModelRegistry } from "./core/model-registry.ts";
import { resolveModelScopeWithDiagnostics, type ResolveModelScopeResult } from "./core/model-resolver-scope.ts";
import type { ScopedModel } from "./core/model-resolver-types.ts";

interface CursorScopeRecoverySession {
	discoverExtensionModels(mode: ExtensionMode): Promise<void>;
	setScopedModels(scopedModels: ScopedModel[]): void;
	setModel(model: Model<Api>): Promise<void>;
}

export interface CursorModelScopeRecoveryInput {
	readonly patterns: readonly string[];
	readonly modelRegistry: ModelRegistry;
	readonly mode: ExtensionMode;
	readonly selectInitialModel: boolean;
	readonly session: CursorScopeRecoverySession;
	/** Current session model, retained when it is present in the resolved scope. */
	readonly currentModel?: Model<Api>;
	/** Saved settings default; only `undefined` is absent, so a blank id "" counts. */
	readonly savedProvider?: string;
	readonly savedModelId?: string;
}

export function modelScopeNeedsCursorDiscovery(patterns: readonly string[]): boolean {
	// Only an explicit lowercase `cursor/<id>` reference reserves authenticated
	// Cursor discovery. Bare references resolve through the ordinary (non-Cursor)
	// scope path; Cursor exposes no static executable catalog.
	return patterns.some((pattern) => parseExactCursorProviderReference(pattern) !== undefined);
}

/**
 * Choose which resolved scope entry to select initially. Precedence:
 * 1. the current session model when it is present in the new scope,
 * 2. the saved settings default when present (only `undefined` is absent, so a
 *    blank id "" is honored; `modelsAreEqual` compares provider+id, so a
 *    duplicate/blank saved default matches the first matching scoped occurrence),
 * 3. the first scoped model.
 */
function selectScopeInitialModel(input: CursorModelScopeRecoveryInput, scopedModels: readonly ScopedModel[]): Model<Api> | undefined {
	const first = scopedModels[0]?.model;
	if (!first) return undefined;
	if (input.currentModel && scopedModels.some((scoped) => modelsAreEqual(scoped.model, input.currentModel!))) {
		return input.currentModel;
	}
	const savedModel = input.savedProvider !== undefined && input.savedModelId !== undefined
		? input.modelRegistry.find(input.savedProvider, input.savedModelId)
		: undefined;
	const preferred = savedModel ? scopedModels.find((scoped) => modelsAreEqual(scoped.model, savedModel)) : undefined;
	return preferred?.model ?? first;
}

/**
 * Resolve strict Cursor-enabled model entries only after dynamic providers have
 * published the authenticated catalog. Non-Cursor scopes keep their existing
 * zero-discovery startup path.
 */
export async function recoverCursorModelScopeAfterExtensionStartup(
	input: CursorModelScopeRecoveryInput,
): Promise<ResolveModelScopeResult | undefined> {
	if (!modelScopeNeedsCursorDiscovery(input.patterns)) return undefined;
	try {
		await input.session.discoverExtensionModels(input.mode);
	} catch {
		const failed: ResolveModelScopeResult = {
			scopedModels: [],
			diagnostics: [{
				type: "error",
				message: "Cursor model discovery failed. Refresh the catalog and reselect an exact model with --list-models.",
			}],
		};
		input.session.setScopedModels([]);
		return failed;
	}
	const result = await resolveModelScopeWithDiagnostics([...input.patterns], input.modelRegistry);
	input.session.setScopedModels(result.scopedModels);
	if (input.selectInitialModel) {
		const initial = selectScopeInitialModel(input, result.scopedModels);
		if (initial) await input.session.setModel(initial);
	}
	return result;
}
