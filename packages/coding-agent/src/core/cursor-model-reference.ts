const CURSOR_PROVIDER = "cursor";
const CURSOR_PREFIX = `${CURSOR_PROVIDER}/`;

export function parseExactCursorProviderReference(reference: string): string | undefined {
	return reference.startsWith(CURSOR_PREFIX) ? reference.slice(CURSOR_PREFIX.length) : undefined;
}

export function hasNormalizedCursorProviderQualifier(reference: string): boolean {
	const slashIndex = reference.indexOf("/");
	return slashIndex >= 0 && isNormalizedCursorProviderVariant(reference.slice(0, slashIndex));
}

export function isExactCursorProvider(provider: string | undefined): boolean {
	return provider === CURSOR_PROVIDER;
}

export function isNormalizedCursorProviderVariant(provider: string): boolean {
	return provider !== CURSOR_PROVIDER && provider.trim().toLowerCase() === CURSOR_PROVIDER;
}

/** Preserve reserved Cursor reference bytes while retaining historical trimming for other providers. */
export function trimNonCursorModelReference(reference: string): string {
	return parseExactCursorProviderReference(reference) !== undefined || hasNormalizedCursorProviderQualifier(reference)
		? reference
		: reference.trim();
}

/**
 * Resolve a provider name without ever canonicalizing a case/whitespace variant
 * into the reserved lowercase Cursor identity. Exact spelling wins; ordinary
 * non-Cursor providers retain the historical case-insensitive fallback.
 */
export function resolveProviderIdentity(
	provider: string,
	availableProviders: readonly string[],
): string | undefined {
	const exact = availableProviders.find((candidate) => candidate === provider);
	if (exact !== undefined) return exact;
	if (isExactCursorProvider(provider)) return undefined;
	const lower = provider.toLowerCase();
	return availableProviders.find(
		(candidate) => !isExactCursorProvider(candidate) && candidate.toLowerCase() === lower,
	);
}
