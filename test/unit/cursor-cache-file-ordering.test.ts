import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveCursorCredentialScope, FileCursorCatalogCache } from "../../packages/cursor/src/catalog-cache.js";

function jwtForSubject(subject: string): string {
	return `header.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.signature`;
}

describe("FileCursorCatalogCache timestamp ordering", () => {
	test("an equal-timestamp later same-scope save wins; strictly older cannot overwrite", () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-cursor-cache-order-"));
		try {
			const cachePath = join(dir, "catalog.json");
			const cache = new FileCursorCatalogCache(cachePath);
			const scope = deriveCursorCredentialScope(jwtForSubject("account-order"));
			assert.ok(scope);

			cache.save({ source: "live", fetchedAt: 77, models: [{ id: "first", maxMode: false }] }, scope);
			// Same millisecond timestamp, later invocation replaces (invocation-ordered per scope).
			cache.save({ source: "live", fetchedAt: 77, models: [{ id: "equal-later", maxMode: true }] }, scope);
			assert.deepEqual(cache.load(scope), {
				source: "live",
				fetchedAt: 77,
				credentialScope: scope,
				models: [{ id: "equal-later", maxMode: true }],
			});

			// A strictly older save is rejected; a strictly newer save replaces.
			cache.save({ source: "live", fetchedAt: 76, models: [{ id: "strictly-older", maxMode: false }] }, scope);
			assert.equal(cache.load(scope)?.models[0]?.id, "equal-later");
			cache.save({ source: "live", fetchedAt: 78, models: [{ id: "strictly-newer", maxMode: false }] }, scope);
			assert.equal(cache.load(scope)?.models[0]?.id, "strictly-newer");

			assert.equal(readdirSync(dir).some((entry) => entry.endsWith(".tmp") || entry.endsWith(".lock")), false);
			if (process.platform !== "win32") {
				assert.equal(statSync(`${cachePath}.${scope}`).mode & 0o777, 0o600);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
