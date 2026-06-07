import { THINKING_LEVELS, splitKnownThinkingSuffix, type ModelInfo as AvailableModelInfo } from "../../shared/model-info.ts";
import type { Usage } from "../../shared/types.ts";

export type { AvailableModelInfo };

interface ModelAttemptSummary {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

export interface StructuredProviderFailureSignal {
	readonly message?: string;
	readonly code?: unknown;
	readonly status?: unknown;
	readonly diagnostics?: unknown;
	readonly errorMessage?: unknown;
	readonly stopReason?: unknown;
}

export type StructuredProviderFailureMessage = Omit<StructuredProviderFailureSignal, "message">;

function applyFallbackThinkingLevel(model: string, thinkingLevel: string | undefined): string {
	if (!thinkingLevel || !THINKING_LEVELS.some((level) => level === thinkingLevel)) return model;
	const { thinkingSuffix } = splitKnownThinkingSuffix(model);
	return thinkingSuffix ? model : `${model}:${thinkingLevel}`;
}

export function resolveModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	if (model.includes("/")) return model;
	if (!availableModels || availableModels.length === 0) return model;

	const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(model);
	const matches = availableModels.filter((entry) => entry.id === baseModel);
	if (preferredProvider) {
		const preferredMatch = matches.find((entry) => entry.provider === preferredProvider);
		if (preferredMatch) return `${preferredMatch.fullId}${thinkingSuffix}`;
	}
	if (matches.length !== 1) return model;
	return `${matches[0]!.fullId}${thinkingSuffix}`;
}

export function buildModelCandidates(
	primaryModel: string | undefined,
	fallbackModels: string[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	currentModel?: string,
	fallbackThinkingLevels?: string[],
): string[] {
	const seen = new Set<string>();
	const candidates: string[] = [];
	const fallbackEntries = (fallbackModels ?? []).map((model, index) => applyFallbackThinkingLevel(model, fallbackThinkingLevels?.[index]));
	for (const raw of [primaryModel, ...fallbackEntries, currentModel]) {
		if (!raw) continue;
		const normalized = resolveModelCandidate(raw.trim(), availableModels, preferredProvider);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		candidates.push(normalized);
	}
	return candidates;
}

export function currentModelFullId(model: { provider: string; id: string } | undefined): string | undefined {
	if (!model) return undefined;
	return `${String(model.provider)}/${model.id}`;
}

const RETRYABLE_MODEL_FAILURE_PATTERNS = [
	/rate\s*limit/i,
	/too many requests/i,
	/\b(?:401|403|429|5\d{2})\b/,
	/quota/i,
	/billing/i,
	/credit/i,
	/auth(?:entication)?/i,
	/unauthori[sz]ed/i,
	/forbidden/i,
	/api key/i,
	/token expired/i,
	/invalid key/i,
	/provider.*unavailable/i,
	/model.*unavailable/i,
	/model.*disabled/i,
	/model.*not found/i,
	/unknown model/i,
	/overloaded/i,
	/service unavailable/i,
	/temporar(?:ily)? unavailable/i,
	/connection refused/i,
	/fetch failed/i,
	/network error/i,
	/socket hang up/i,
	/upstream/i,
	/timed? out/i,
	/timeout/i,
];

const LOCAL_FAILURE_PATTERNS = [
	/\bcommand\s+failed\b/i,
	/\btask\s+failed\b/i,
	/\btool(?:\s+call)?\s+failed\b/i,
	/\bshell\b/i,
	/\btests?\s+failed\b/i,
	/\bcompletion[-\s]?guard\b/i,
	/\bcancel\b/i,
	/\bcancell?ed\b/i,
	/\bcancell?ation\b/i,
	/\babort(?:ed)?\b/i,
	/\binterrupted\b/i,
	/\bmissing\s+file\b/i,
	/\bno\s+such\s+file\b/i,
];

const SIGNAL_MAX_DEPTH = 8;
const SIGNAL_TEXT_KEYS = ["code", "status", "statusCode", "httpStatus", "message", "errorMessage", "statusText", "error", "type", "name", "stopReason"] as const;
const SIGNAL_NESTED_KEYS = ["diagnostics", "cause", "error", "response", "body"] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function integerFrom(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	const parsed = Number(value.trim());
	return Number.isInteger(parsed) ? parsed : undefined;
}

function nestedSignalValues(value: unknown): readonly unknown[] {
	if (Array.isArray(value)) return value;
	const record = asRecord(value);
	if (record === undefined) return [];
	const nested: unknown[] = [];
	for (const key of SIGNAL_NESTED_KEYS) {
		const item = record[key];
		if (item !== undefined && item !== null) nested.push(item);
	}
	return nested;
}

function collectSignalParts(value: unknown, seen = new Set<unknown>(), depth = 0): readonly string[] {
	if (value === undefined || value === null || depth > SIGNAL_MAX_DEPTH) return [];
	if (typeof value === "string") return value.trim() ? [value.trim()] : [];
	if (typeof value === "number") return [String(value)];
	if (typeof value !== "object") return [];
	if (seen.has(value)) return [];
	seen.add(value);

	const parts: string[] = [];
	const record = asRecord(value);
	if (record !== undefined) {
		for (const key of SIGNAL_TEXT_KEYS) {
			const part = record[key];
			if (typeof part === "string" && part.trim()) parts.push(`${key}: ${part.trim()}`);
			else if (typeof part === "number") parts.push(`${key}: ${String(part)}`);
		}
	}
	for (const nested of nestedSignalValues(value)) {
		parts.push(...collectSignalParts(nested, seen, depth + 1));
	}
	return parts;
}

function signalPart(value: unknown): string | undefined {
	const parts = collectSignalParts(value);
	return parts.length > 0 ? parts.join(", ") : undefined;
}

function isPresentString(value: string | undefined): value is string {
	return value !== undefined && value.length > 0;
}

function isRetryableFailureCode(code: number): boolean {
	return code === 401 || code === 403 || code === 429 || (code >= 500 && code <= 599);
}

function hasStructuredStopReason(value: unknown, expected: string, seen = new Set<unknown>(), depth = 0): boolean {
	if (value === undefined || value === null || depth > SIGNAL_MAX_DEPTH || typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	const record = asRecord(value);
	const stopReason = record?.stopReason;
	if (typeof stopReason === "string" && stopReason.toLowerCase() === expected) return true;
	for (const nested of nestedSignalValues(value)) {
		if (hasStructuredStopReason(nested, expected, seen, depth + 1)) return true;
	}
	return false;
}

function hasRetryableStructuredSignal(value: unknown, seen = new Set<unknown>(), depth = 0): boolean {
	if (value === undefined || value === null || depth > SIGNAL_MAX_DEPTH) return false;
	const directCode = integerFrom(value);
	if (directCode !== undefined && isRetryableFailureCode(directCode)) return true;
	if (typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);

	const record = asRecord(value);
	if (record !== undefined) {
		for (const key of ["status", "statusCode", "httpStatus", "code"] as const) {
			const code = integerFrom(record[key]);
			if (code !== undefined && isRetryableFailureCode(code)) return true;
		}
	}
	for (const nested of nestedSignalValues(value)) {
		if (hasRetryableStructuredSignal(nested, seen, depth + 1)) return true;
	}
	return false;
}

export function structuredProviderFailureSignal(message: object, text?: string): StructuredProviderFailureSignal | undefined {
	const signal = message as StructuredProviderFailureMessage;
	const stopReason = typeof signal.stopReason === "string" ? signal.stopReason : undefined;
	if (signal.errorMessage === undefined && signal.code === undefined && signal.status === undefined && signal.diagnostics === undefined && stopReason !== "error" && stopReason !== "aborted") {
		return undefined;
	}
	return {
		...(typeof text === "string" && text.trim() ? { message: text.trim() } : {}),
		...(signal.errorMessage !== undefined ? { errorMessage: signal.errorMessage } : {}),
		...(signal.code !== undefined ? { code: signal.code } : {}),
		...(signal.status !== undefined ? { status: signal.status } : {}),
		...(signal.diagnostics !== undefined ? { diagnostics: signal.diagnostics } : {}),
		...(stopReason !== undefined ? { stopReason } : {}),
	};
}

export function providerFailureSignalText(signal: StructuredProviderFailureSignal | undefined): string | undefined {
	if (signal === undefined) return undefined;
	const parts = [
		signalPart(signal.errorMessage),
		signalPart(signal.message),
		signalPart(signal.code),
		signalPart(signal.status),
		signalPart(signal.diagnostics),
		signalPart(signal.stopReason),
	].filter(isPresentString);
	return parts.length > 0 ? parts.join("; ") : undefined;
}

export function hasNonRetryableModelFailureGuard(error: unknown): boolean {
	if (error === undefined) return false;
	const parts = collectSignalParts(error);
	return parts.some((part) => LOCAL_FAILURE_PATTERNS.some((pattern) => pattern.test(part)))
		|| hasStructuredStopReason(error, "aborted");
}

export function isRetryableModelFailure(error: unknown): boolean {
	if (error === undefined) return false;
	const parts = collectSignalParts(error);
	if (parts.length === 0) return false;
	if (hasNonRetryableModelFailureGuard(error)) return false;
	if (hasRetryableStructuredSignal(error)) return true;
	if (hasStructuredStopReason(error, "error")) return true;
	return parts.some((part) => RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(part)));
}

export function isRetryableProviderFailureSignal(signal: StructuredProviderFailureSignal | undefined): boolean {
	return isRetryableModelFailure(signal);
}

export function isRetryableAttemptFailure(
	error: unknown,
	providerFailureSignal: StructuredProviderFailureSignal | undefined,
): boolean {
	if (hasNonRetryableModelFailureGuard(error)) return false;
	return providerFailureSignal !== undefined
		? isRetryableProviderFailureSignal(providerFailureSignal)
		: isRetryableModelFailure(error);
}

export function formatModelAttemptNote(attempt: ModelAttemptSummary, nextModel?: string): string {
	const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
	return nextModel
		? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
		: `[fallback] ${attempt.model} failed: ${failure}.`;
}
