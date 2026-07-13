import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("file lock handoff never admits two processes to the critical section", async () => {
  const dir = mkdtempSync(join(tmpdir(), "durable-file-lock-race-"));
  const stateFile = join(dir, "state.json");
  const criticalDir = join(dir, "critical");
  const modulePath = join(process.cwd(), "packages/workflows/src/durable/file-lock.ts");
  const script = `
    import { mkdirSync, rmSync } from "node:fs";
    import { withFileLock } from ${JSON.stringify(modulePath)};
    const [stateFile, criticalDir] = process.argv.slice(1);
    for (let i = 0; i < 500; i++) withFileLock(stateFile, () => {
      mkdirSync(criticalDir);
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); }
      finally { rmSync(criticalDir, { recursive: true, force: true }); }
    });
  `;
  try {
    const children = [0, 1].map(() => Bun.spawn(["bun", "-e", script, stateFile, criticalDir], { stdout: "ignore", stderr: "pipe" }));
    const exits = await Promise.all(children.map((child) => child.exited));
    const errors = await Promise.all(children.map(async (child) => new Response(child.stderr).text()));
    assert.deepEqual(exits, [0, 0], errors.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
