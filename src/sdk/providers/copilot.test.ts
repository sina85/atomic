import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  copilotSubprocessEnv,
  copilotSdkLaunchOptions,
  resolveCopilotCliPath,
} from "./copilot.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTempCopilotBin(): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "atomic-copilot-test-"));
  const bin = join(dir, "copilot");
  writeFileSync(bin, "#!/bin/sh\necho copilot\n", { encoding: "utf-8" });
  chmodSync(bin, 0o755);
  return { dir, bin };
}

function makeEmptyTempDir(): string {
  return mkdtempSync(join(tmpdir(), "atomic-copilot-empty-"));
}

// ── resolveCopilotCliPath ─────────────────────────────────────────────────

describe("resolveCopilotCliPath", () => {
  let origCliPath: string | undefined;
  let origPath: string | undefined;

  beforeEach(() => {
    origCliPath = process.env["COPILOT_CLI_PATH"];
    origPath = process.env["PATH"];
  });

  afterEach(() => {
    if (origCliPath === undefined) {
      delete process.env["COPILOT_CLI_PATH"];
    } else {
      process.env["COPILOT_CLI_PATH"] = origCliPath;
    }
    if (origPath === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = origPath;
    }
  });

  test("COPILOT_CLI_PATH env var takes precedence over PATH", () => {
    const explicit = "/custom/bin/copilot";
    process.env["COPILOT_CLI_PATH"] = explicit;
    // even if PATH has a copilot binary, the env var wins
    expect(resolveCopilotCliPath()).toBe(explicit);
  });

  test("PATH-resolved copilot binary populates cliPath when env var unset", () => {
    delete process.env["COPILOT_CLI_PATH"];
    const { dir, bin } = makeTempCopilotBin();
    process.env["PATH"] = `${dir}:${origPath ?? ""}`;
    const result = resolveCopilotCliPath();
    expect(result).toBe(bin);
  });

  test("returns undefined when copilot not on PATH and env var unset", () => {
    delete process.env["COPILOT_CLI_PATH"];
    const emptyDir = makeEmptyTempDir();
    process.env["PATH"] = emptyDir;
    const result = resolveCopilotCliPath();
    expect(result).toBeUndefined();
  });
});

// ── copilotSubprocessEnv ──────────────────────────────────────────────────

describe("copilotSubprocessEnv", () => {
  test("NODE_NO_WARNINGS is set to '1'", () => {
    const env = copilotSubprocessEnv({});
    expect(env["NODE_NO_WARNINGS"]).toBe("1");
  });

  test("UTF-8 locale defaults applied when base env empty", () => {
    const env = copilotSubprocessEnv({});
    expect(env["LANG"]).toBe("en_US.UTF-8");
    expect(env["LC_ALL"]).toBe("en_US.UTF-8");
    expect(env["LC_CTYPE"]).toBe("en_US.UTF-8");
  });

  test("UTF-8 env vars from base merged into result", () => {
    const base = {
      LANG: "fr_FR.UTF-8",
      LC_ALL: "fr_FR.UTF-8",
      LC_CTYPE: "fr_FR.UTF-8",
      MY_CUSTOM: "hello",
    };
    const env = copilotSubprocessEnv(base);
    expect(env["LANG"]).toBe("fr_FR.UTF-8");
    expect(env["LC_ALL"]).toBe("fr_FR.UTF-8");
    expect(env["MY_CUSTOM"]).toBe("hello");
    expect(env["NODE_NO_WARNINGS"]).toBe("1");
  });

  test("NODE_NO_WARNINGS=1 overrides any base value", () => {
    const env = copilotSubprocessEnv({ NODE_NO_WARNINGS: "0" });
    expect(env["NODE_NO_WARNINGS"]).toBe("1");
  });

  test("returns fresh object per call (no shared state)", () => {
    const a = copilotSubprocessEnv({});
    const b = copilotSubprocessEnv({});
    expect(a).not.toBe(b);
  });
});

// ── copilotSdkLaunchOptions ───────────────────────────────────────────────

describe("copilotSdkLaunchOptions", () => {
  let origCliPath: string | undefined;
  let origPath: string | undefined;

  beforeEach(() => {
    origCliPath = process.env["COPILOT_CLI_PATH"];
    origPath = process.env["PATH"];
  });

  afterEach(() => {
    if (origCliPath === undefined) {
      delete process.env["COPILOT_CLI_PATH"];
    } else {
      process.env["COPILOT_CLI_PATH"] = origCliPath;
    }
    if (origPath === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = origPath;
    }
  });

  test("env contains NODE_NO_WARNINGS=1", () => {
    const opts = copilotSdkLaunchOptions();
    expect(opts.env?.["NODE_NO_WARNINGS"]).toBe("1");
  });

  test("cliPath populated from COPILOT_CLI_PATH", () => {
    process.env["COPILOT_CLI_PATH"] = "/my/copilot";
    const opts = copilotSdkLaunchOptions();
    expect(opts.cliPath).toBe("/my/copilot");
  });

  test("cliPath omitted when copilot not resolvable", () => {
    delete process.env["COPILOT_CLI_PATH"];
    const emptyDir = makeEmptyTempDir();
    process.env["PATH"] = emptyDir;
    const opts = copilotSdkLaunchOptions();
    expect("cliPath" in opts).toBe(false);
  });

  test("cliPath populated from PATH-resolved binary", () => {
    delete process.env["COPILOT_CLI_PATH"];
    const { dir, bin } = makeTempCopilotBin();
    process.env["PATH"] = `${dir}:${origPath ?? ""}`;
    const opts = copilotSdkLaunchOptions();
    expect(opts.cliPath).toBe(bin);
  });
});
