import { describe, expect, it } from "vitest";
import { normalizeAtomicGuideMode } from "../src/core/atomic-guide-command.js";

describe("atomic guide command", () => {
	it("normalizes supported guide modes", () => {
		expect(normalizeAtomicGuideMode("")).toBe("help");
		expect(normalizeAtomicGuideMode("overview?")).toBe("overview");
		expect(normalizeAtomicGuideMode("workflow")).toBe("workflows");
		expect(normalizeAtomicGuideMode("examples!!!")).toBe("example");
		expect(normalizeAtomicGuideMode("what's new!!!")).toBe("whats-new");
	});

	it("treats adversarial punctuation arguments as unknown help requests", () => {
		expect(normalizeAtomicGuideMode(`${"!".repeat(50_000)}a`)).toBe("help");
	});
});
