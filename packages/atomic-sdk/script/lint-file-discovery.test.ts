import { test, expect, describe } from "bun:test";
import { scanForViolations, type Violation } from "./lint-file-discovery";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `lint-fd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

// ── Case 1: allowlisted file containing pattern → no violation ────────────────

describe("scanForViolations — allowlisted file", () => {
  test("file-discovery.ts is allowlisted → no violation even with git ls-files spawn", () => {
    const dir = makeTmpDir();
    try {
      writeFile(dir, "file-discovery.ts", `
        const result = Bun.spawnSync({
          cmd: ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
          cwd: root,
          stdout: "pipe",
        });
      `);

      const violations = scanForViolations(dir, new Set(["file-discovery.ts"]));
      expect(violations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Case 2: non-allowlist file with Bun.spawn({ cmd: ["git", "ls-files",...] → violation ──

describe("scanForViolations — Bun.spawn violation", () => {
  test("non-allowlist file with Bun.spawn git ls-files → violation with correct path", () => {
    const dir = makeTmpDir();
    try {
      writeFile(dir, "preflight.ts", `
        const proc = Bun.spawn({
          cmd: ["git", "ls-files"],
          cwd: root,
          stdout: "pipe",
        });
      `);

      const violations = scanForViolations(dir, new Set(["file-discovery.ts"]));
      expect(violations.length).toBeGreaterThanOrEqual(1);
      const v = violations[0];
      expect(v.file).toContain("preflight.ts");
      expect(v.line).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("violation file path is the absolute path to the file", () => {
    const dir = makeTmpDir();
    try {
      const filePath = writeFile(dir, "bad-file.ts", `
        const proc = Bun.spawn({
          cmd: ["git", "ls-files"],
          cwd: someDir,
          stdout: "pipe",
        });
      `);

      const violations = scanForViolations(dir, new Set());
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations[0].file).toBe(filePath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Case 3: Bun.spawnSync with git ls-files → violation ──────────────────────

describe("scanForViolations — Bun.spawnSync violation", () => {
  test("non-allowlist file with Bun.spawnSync git ls-files → violation", () => {
    const dir = makeTmpDir();
    try {
      writeFile(dir, "scout.ts", `
        const result = Bun.spawnSync({
          cmd: ["git", "ls-files"],
          cwd: root,
        });
      `);

      const violations = scanForViolations(dir, new Set(["file-discovery.ts"]));
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations[0].file).toContain("scout.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Bun.spawnSync with extra flags between git and ls-files → violation", () => {
    const dir = makeTmpDir();
    try {
      writeFile(dir, "helper.ts", `
        const r = Bun.spawnSync({
          cmd: ["git", "ls-files", "--cached", "--others"],
          cwd: root,
        });
      `);

      const violations = scanForViolations(dir, new Set());
      expect(violations.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Case 4: unrelated Bun.spawn with git status → no violation ───────────────

describe("scanForViolations — unrelated spawn", () => {
  test("Bun.spawn with git status (not ls-files) → no violation", () => {
    const dir = makeTmpDir();
    try {
      writeFile(dir, "other.ts", `
        const proc = Bun.spawn({
          cmd: ["git", "status"],
          cwd: root,
          stdout: "pipe",
        });
      `);

      const violations = scanForViolations(dir, new Set(["file-discovery.ts"]));
      expect(violations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Bun.spawn with rg --files → no violation", () => {
    const dir = makeTmpDir();
    try {
      writeFile(dir, "other.ts", `
        const rg = Bun.spawnSync({
          cmd: ["rg", "--files", "--hidden"],
          cwd: root,
          stdout: "pipe",
        });
      `);

      const violations = scanForViolations(dir, new Set());
      expect(violations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Case 5: comment/string with "git ls-files" not in cmd array → no violation

describe("scanForViolations — git ls-files in comment only", () => {
  test("git ls-files in a comment (no cmd: array context) → no violation", () => {
    const dir = makeTmpDir();
    try {
      writeFile(dir, "docs.ts", `
        // This module avoids calling git ls-files directly.
        // Use listAllFiles() instead of git ls-files in your code.
        export function listFiles(root: string): string[] {
          return [];
        }
      `);

      const violations = scanForViolations(dir, new Set());
      expect(violations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("git ls-files in a plain string (no spawn, no cmd:) → no violation", () => {
    const dir = makeTmpDir();
    try {
      writeFile(dir, "readme.ts", `
        const description = "This tool runs git ls-files to list files";
        export { description };
      `);

      const violations = scanForViolations(dir, new Set());
      expect(violations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Multiple violations in one file ──────────────────────────────────────────

describe("scanForViolations — multiple violations", () => {
  test("file with two separate spawn calls → two violations reported", () => {
    const dir = makeTmpDir();
    try {
      writeFile(dir, "multi.ts", `
        const a = Bun.spawn({
          cmd: ["git", "ls-files"],
          cwd: root,
        });
        const b = Bun.spawnSync({
          cmd: ["git", "ls-files", "--others"],
          cwd: root,
        });
      `);

      const violations = scanForViolations(dir, new Set());
      // Each pattern fires once per match; two distinct calls should produce violations.
      expect(violations.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Non-.ts files ignored ────────────────────────────────────────────────────

describe("scanForViolations — file extension filtering", () => {
  test(".js file with violation is not scanned (only .ts/.tsx)", () => {
    const dir = makeTmpDir();
    try {
      writeFile(dir, "bad.js", `
        const proc = Bun.spawn({
          cmd: ["git", "ls-files"],
          cwd: root,
        });
      `);

      const violations = scanForViolations(dir, new Set());
      expect(violations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(".tsx file with violation is scanned", () => {
    const dir = makeTmpDir();
    try {
      writeFile(dir, "component.tsx", `
        const proc = Bun.spawn({
          cmd: ["git", "ls-files"],
          cwd: root,
        });
      `);

      const violations = scanForViolations(dir, new Set());
      expect(violations.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
