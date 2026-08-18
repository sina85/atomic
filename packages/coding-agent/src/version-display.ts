import { readFileSync } from "node:fs";

/**
 * `--version` text formatting, shared by every entry point that prints it.
 *
 * This lives outside `config.ts` because the Bun split launcher resolves its own
 * manifest next to the executable and must not pull in the config module graph.
 * Both routes format through `formatVersionOutput`, so a fork label cannot show
 * up on one build and be missing from another.
 */

/** Project a fork build reports itself as derived from. */
const UPSTREAM_TITLE = "Atomic";

/** Version printed when no manifest version is readable. */
const PLACEHOLDER_VERSION = "0.0.0";

/**
 * Optional fork labelling read from the manifest's app config
 * (`atomicConfig`, with `piConfig` as the legacy shim).
 *
 * Both fields are absent on upstream builds, which then print the package
 * version alone.
 */
export interface ForkVersionMetadata {
	/** Replaces the package version on the first line, e.g. `0.9.14-alpha.3-sina`. */
	versionLabel?: string;
	/** Upstream release the fork was taken from; adds the `forked from` line. */
	forkedFromVersion?: string;
}

interface VersionManifest {
	version?: string;
	atomicConfig?: ForkVersionMetadata;
	piConfig?: ForkVersionMetadata;
}

/**
 * Manifest values are untrusted, so a non-string or blank entry is dropped
 * rather than printed. A half-filled manifest degrades to upstream output
 * instead of emitting an empty line or a dangling `forked from`.
 */
function displayValue(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build the text `--version` and `-v` print.
 *
 * Without fork metadata this is the package version alone — exactly what every
 * upstream build prints.
 */
export function formatVersionOutput(version: string, fork?: ForkVersionMetadata): string {
	const label = displayValue(fork?.versionLabel) ?? version;
	const forkedFrom = displayValue(fork?.forkedFromVersion);
	return forkedFrom === undefined ? label : `${label}\nforked from ${UPSTREAM_TITLE} ${forkedFrom}`;
}

/**
 * Format `--version` output from a manifest on disk, for callers that read one
 * themselves instead of going through `config.ts`.
 *
 * A missing or malformed manifest falls back to the placeholder version, which
 * is what those callers printed before fork labelling existed.
 */
export function readVersionOutput(packageJsonPath: string): string {
	try {
		const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as VersionManifest;
		const version = typeof manifest.version === "string" ? manifest.version : PLACEHOLDER_VERSION;
		return formatVersionOutput(version, manifest.atomicConfig ?? manifest.piConfig);
	} catch {
		return PLACEHOLDER_VERSION;
	}
}
