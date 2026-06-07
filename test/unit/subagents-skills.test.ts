import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    buildSkillInjection,
    clearSkillCache,
    resolveSkills,
} from "../../packages/subagents/src/agents/skills.js";

const repoRoot = resolve(import.meta.dir, "../..");
const builtinSubagentsSkillsRoot = join(
    repoRoot,
    "packages",
    "subagents",
    "skills",
);
const browserSkillPath = join(builtinSubagentsSkillsRoot, "browser", "SKILL.md");
const browserUseSkillPath = join(builtinSubagentsSkillsRoot, "browser-use", "SKILL.md");
const browserPackageFiles = ["SKILL.md", "EXAMPLES.md", "REFERENCE.md", "LICENSE.txt"] as const;
const browserUseReferenceFiles = ["cdp-python.md", "multi-session.md"] as const;

function gitLines(args: string[]): string[] {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8" })
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

let previousAtomicAgentDir: string | undefined;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let isolatedAgentDir: string;
const cleanupPaths = new Set<string>();

beforeEach(() => {
    previousAtomicAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    isolatedAgentDir = mkdtempSync(
        join(tmpdir(), "atomic-subagents-skills-agent-"),
    );
    cleanupPaths.add(isolatedAgentDir);
    process.env.ATOMIC_CODING_AGENT_DIR = isolatedAgentDir;
    process.env.HOME = isolatedAgentDir;
    process.env.USERPROFILE = isolatedAgentDir;
    clearSkillCache();
});

afterEach(() => {
    if (previousAtomicAgentDir === undefined)
        delete process.env.ATOMIC_CODING_AGENT_DIR;
    else process.env.ATOMIC_CODING_AGENT_DIR = previousAtomicAgentDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    for (const cleanupPath of cleanupPaths) {
        rmSync(cleanupPath, { recursive: true, force: true });
    }
    cleanupPaths.clear();
    clearSkillCache();
});

describe("subagent skill resolution", () => {
    test("resolves builtin tdd, browser, and browser-use skills from the repo root", () => {
        const result = resolveSkills(["tdd", "browser", "browser-use"], repoRoot);

        const resolvedByName = new Map(
            result.resolved.map((skill) => [skill.name, skill]),
        );

        assert.deepEqual(result.missing, []);
        assert.deepEqual([...resolvedByName.keys()].sort(), [
            "browser",
            "browser-use",
            "tdd",
        ]);
        assert.equal(resolvedByName.get("tdd")?.source, "builtin");
        assert.equal(
            resolvedByName.get("tdd")?.path,
            join(builtinSubagentsSkillsRoot, "tdd", "SKILL.md"),
        );
        assert.equal(resolvedByName.get("browser")?.source, "builtin");
        assert.equal(resolvedByName.get("browser")?.path, browserSkillPath);
        assert.equal(resolvedByName.get("browser-use")?.source, "builtin");
        assert.equal(resolvedByName.get("browser-use")?.path, browserUseSkillPath);
        assert.notEqual(
            resolvedByName.get("browser")?.path,
            resolvedByName.get("browser-use")?.path,
        );

        const browserSkill = readFileSync(browserSkillPath, "utf-8");
        const browserUseSkill = readFileSync(browserUseSkillPath, "utf-8");
        assert.match(browserSkill, /^name: browser$/m);
        assert.match(browserSkill, /^allowed-tools: Bash$/m);
        assert.match(browserSkill, /browse CLI/);
        assert.match(browserUseSkill, /^name: browser-use$/m);
        for (const file of browserPackageFiles) {
            assert.equal(
                existsSync(join(builtinSubagentsSkillsRoot, "browser", file)),
                true,
                file,
            );
        }
        for (const file of browserUseReferenceFiles) {
            assert.equal(
                existsSync(join(builtinSubagentsSkillsRoot, "browser-use", "references", file)),
                true,
                file,
            );
        }
    });

    test("keeps browser and browser-use builtin skill files package-visible", () => {
        const expectedFiles = [
            ...browserPackageFiles.map((file) => `packages/subagents/skills/browser/${file}`),
            "packages/subagents/skills/browser-use/SKILL.md",
            ...browserUseReferenceFiles.map((file) => `packages/subagents/skills/browser-use/references/${file}`),
        ];
        const tracked = new Set(
            gitLines(["ls-files", "packages/subagents/skills/browser", "packages/subagents/skills/browser-use"]),
        );

        for (const file of expectedFiles) {
            assert.equal(existsSync(join(repoRoot, file)), true, file);
            assert.equal(tracked.has(file), true, `${file} must be tracked by git ls-files`);
        }

        assert.notEqual(
            readFileSync(browserSkillPath, "utf-8"),
            readFileSync(browserUseSkillPath, "utf-8"),
        );
        assert.match(
            readFileSync(join(repoRoot, "packages", "subagents", "package.json"), "utf-8"),
            /"skills\/\*\*\/\*"/,
        );
    });

    test("builds skill injection for builtin skills without YAML frontmatter", () => {
        const result = resolveSkills(["tdd", "browser"], repoRoot);
        const injection = buildSkillInjection(result.resolved);

        assert.equal(result.missing.length, 0);
        assert.match(injection, /<skill name="tdd">/);
        assert.match(injection, /<skill name="browser">/);
        assert.doesNotMatch(injection, /<skill name="tdd">\n---\nname: tdd/);
        assert.doesNotMatch(
            injection,
            /<skill name="browser">\n---\nname: browser/,
        );
    });

    test("prefers a project tdd skill over the builtin tdd skill", () => {
        const cwd = mkdtempSync(
            join(tmpdir(), "atomic-subagents-skills-project-"),
        );
        cleanupPaths.add(cwd);
        const projectTddDir = join(cwd, ".agents", "skills", "tdd");
        const projectTddPath = join(projectTddDir, "SKILL.md");
        mkdirSync(projectTddDir, { recursive: true });
        writeFileSync(
            projectTddPath,
            "---\nname: tdd\ndescription: Project override\n---\n\n# Project TDD\n\nUse the project-specific process.\n",
            "utf-8",
        );

        const result = resolveSkills(["tdd"], cwd);

        assert.deepEqual(result.missing, []);
        assert.equal(result.resolved[0]?.path, projectTddPath);
        assert.equal(result.resolved[0]?.source, "project");
        assert.match(result.resolved[0]?.content ?? "", /# Project TDD/);
    });

    test("does not resolve the builtin subagent orchestration skill for child injection", () => {
        const result = resolveSkills(["subagent"], repoRoot);

        assert.deepEqual(result.resolved, []);
        assert.deepEqual(result.missing, ["subagent"]);
    });
});
