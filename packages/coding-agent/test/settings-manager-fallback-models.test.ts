import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

const testDir = join(process.cwd(), "test-settings-fallback-models-tmp");
const agentDir = join(testDir, "agent");
const projectDir = join(testDir, "project");

beforeEach(() => {
	rmSync(testDir, { recursive: true, force: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
});

afterEach(() => rmSync(testDir, { recursive: true, force: true }));

test("fallback settings preserve exact and lookalike Cursor bytes while trimming ordinary providers", () => {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		fallbackModels: [
			" openai/gpt-4o ",
			"cursor/ route ",
			"cursor/route:high",
			" cursor/route",
			"CURSOR/route",
			"   ",
		],
	}));
	const manager = SettingsManager.create(projectDir, agentDir);
	expect(manager.getFallbackModels()).toEqual([
		"openai/gpt-4o",
		"cursor/ route ",
		"cursor/route:high",
		" cursor/route",
		"CURSOR/route",
	]);
});
