import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getPackageJsonPath, VERSION, VERSION_OUTPUT } from "../src/config.ts";
import { formatVersionOutput, readVersionOutput } from "../src/version-display.ts";
import { bunExecutable, removeTempDirs, runCliProcess } from "./cli-test-helpers.ts";

/**
 * The two lines this fork must print. Written out literally rather than built
 * from the manifest: a test that derives the expectation from the same file the
 * code reads passes whatever the manifest happens to say.
 */
const FORK_VERSION_OUTPUT = "0.9.14-alpha.3-sina\nforked from Atomic 0.9.14-alpha.3";

const splitLoaderPath = fileURLToPath(new URL("../src/bun/split-loader.ts", import.meta.url));

/**
 * Bounds the child rather than the test: a wedged `spawnSync` blocks the worker,
 * so vitest's own budget would never get to fire. Kept under that budget so a
 * hung launcher shows up as this test failing.
 */
const SPLIT_LAUNCHER_PROBE_TIMEOUT_MS = 20_000;

const tempDirs: string[] = [];

afterEach(() => {
	removeTempDirs(tempDirs);
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "atomic-version-output-"));
	tempDirs.push(dir);
	return dir;
}

function writeManifest(contents: string): string {
	const path = join(createTempDir(), "package.json");
	writeFileSync(path, contents, "utf-8");
	return path;
}

describe("formatVersionOutput", () => {
	it("prints the package version alone without fork metadata", () => {
		expect(formatVersionOutput("0.9.14-alpha.3")).toBe("0.9.14-alpha.3");
		expect(formatVersionOutput("0.9.14-alpha.3", {})).toBe("0.9.14-alpha.3");
	});

	it("prints the fork label above the upstream release it was taken from", () => {
		const output = formatVersionOutput("0.0.0", {
			versionLabel: "0.9.14-alpha.3-sina",
			forkedFromVersion: "0.9.14-alpha.3",
		});

		expect(output).toBe(FORK_VERSION_OUTPUT);
	});

	it("ignores blank fork metadata instead of printing an empty line", () => {
		expect(formatVersionOutput("0.9.14-alpha.3", { versionLabel: "   ", forkedFromVersion: "" })).toBe(
			"0.9.14-alpha.3",
		);
	});

	it("uses whichever half of the fork metadata is filled in", () => {
		expect(formatVersionOutput("0.0.0", { versionLabel: "0.9.14-alpha.3-sina" })).toBe("0.9.14-alpha.3-sina");
		expect(formatVersionOutput("0.9.14-alpha.3", { forkedFromVersion: "0.9.14-alpha.2" })).toBe(
			"0.9.14-alpha.3\nforked from Atomic 0.9.14-alpha.2",
		);
	});

	it("trims surrounding whitespace off manifest values", () => {
		expect(
			formatVersionOutput("0.0.0", {
				versionLabel: " 0.9.14-alpha.3-sina\n",
				forkedFromVersion: "\t0.9.14-alpha.3 ",
			}),
		).toBe(FORK_VERSION_OUTPUT);
	});
});

/**
 * The Bun split launcher reads a manifest next to the executable rather than
 * going through config.ts. These cover the reader it calls; the launcher's own
 * fast path runs for real below.
 */
describe("readVersionOutput", () => {
	it("labels output from a manifest that declares fork metadata", () => {
		const path = writeManifest(
			JSON.stringify({
				version: "0.0.0",
				atomicConfig: { versionLabel: "0.9.14-alpha.3-sina", forkedFromVersion: "0.9.14-alpha.3" },
			}),
		);

		expect(readVersionOutput(path)).toBe(FORK_VERSION_OUTPUT);
	});

	it("falls back to the legacy pi app config", () => {
		const path = writeManifest(
			JSON.stringify({
				version: "0.0.0",
				piConfig: { versionLabel: "0.9.14-alpha.3-sina", forkedFromVersion: "0.9.14-alpha.3" },
			}),
		);

		expect(readVersionOutput(path)).toBe(FORK_VERSION_OUTPUT);
	});

	it("prints the manifest version alone for an ordinary upstream build", () => {
		const path = writeManifest(JSON.stringify({ version: "0.9.14-alpha.3", atomicConfig: { name: "atomic" } }));

		expect(readVersionOutput(path)).toBe("0.9.14-alpha.3");
	});

	it("falls back to the placeholder version for a missing or malformed manifest", () => {
		expect(readVersionOutput(join(createTempDir(), "package.json"))).toBe("0.0.0");
		expect(readVersionOutput(writeManifest("{ not json"))).toBe("0.0.0");
		expect(readVersionOutput(writeManifest("null"))).toBe("0.0.0");
		expect(readVersionOutput(writeManifest(JSON.stringify({ version: 14 })))).toBe("0.0.0");
	});
});

/**
 * The shipped binary prints `--version` from the split launcher, which formats
 * the label itself instead of reaching the CLI entry. Covering the reader alone
 * would leave that call site free to drift back to the bare package version, so
 * this runs the launcher module against a faked `process.execPath` — the harness
 * ai-agent-env.test.ts already uses for this file.
 */
describe("split launcher --version", () => {
	it.each(["--version", "-v"])("prints the fork label from the manifest beside the executable for %s", (flag) => {
		const dir = createTempDir();
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({
				version: "0.0.0",
				atomicConfig: { versionLabel: "0.9.14-alpha.3-sina", forkedFromVersion: "0.9.14-alpha.3" },
			}),
			"utf-8",
		);
		// A launcher file, not `bun --eval`: bun claims `--version` for itself before the script sees it.
		const launcher = join(dir, "launcher.ts");
		writeFileSync(
			launcher,
			`Object.defineProperty(process, "execPath", { value: ${JSON.stringify(join(dir, "atomic"))}, configurable: true });
await import(${JSON.stringify(pathToFileURL(splitLoaderPath).href)});
`,
			"utf-8",
		);

		const result = spawnSync(bunExecutable(), [launcher, flag], {
			encoding: "utf8",
			timeout: SPLIT_LAUNCHER_PROBE_TIMEOUT_MS,
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe(`${FORK_VERSION_OUTPUT}\n`);
		expect(result.stderr).toBe("");
	});
});

describe("atomic --version", () => {
	it("exports the fork label without disturbing VERSION", () => {
		const manifest = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8")) as { version: string };

		expect(VERSION_OUTPUT).toBe(FORK_VERSION_OUTPUT);
		expect(VERSION).toBe(manifest.version);
	});

	it.each(["--version", "-v"])("prints exactly two lines on stdout for %s", async (flag) => {
		const result = await runCliProcess([flag], { cwd: createTempDir() });

		expect(result.code).toBe(0);
		expect(result.stdout).toBe(`${FORK_VERSION_OUTPUT}\n`);
		expect(result.stderr).toBe("");
	});
});
