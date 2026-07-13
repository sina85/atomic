import { test } from "bun:test";
import assert from "node:assert/strict";
import { processIdentity } from "../../packages/workflows/src/durable/process-identity.js";

test("processIdentity returns a stable value for a live PID and undefined for invalid PIDs", () => {
  const first = processIdentity(process.pid);
  const second = processIdentity(process.pid);
  assert.equal(first, second);
  assert.equal(typeof first === "string" || first === undefined, true);
  assert.equal(processIdentity(-1), undefined);
  assert.equal(processIdentity(0), undefined);
  assert.equal(processIdentity(1.5), undefined);
});

test("processIdentity is independent of the caller's ambient locale and timezone", () => {
  // A same-host contender running with a different TZ/locale must derive the
  // SAME identity for the same live PID, or it would mistake a live owner for
  // a reused PID and double-dispatch. Probe a real child PID under two locales.
  const child = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
  const pid = child.pid;
  try {
    const original = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
    try {
      process.env.TZ = "America/New_York";
      process.env.LC_ALL = "en_US.UTF-8";
      process.env.LANG = "en_US.UTF-8";
      const eastern = processIdentity(pid);
      process.env.TZ = "Asia/Tokyo";
      process.env.LC_ALL = "de_DE.UTF-8";
      process.env.LANG = "de_DE.UTF-8";
      const tokyo = processIdentity(pid);
      assert.equal(eastern, tokyo);
      assert.equal(typeof eastern, "string");
    } finally {
      process.env.TZ = original.TZ;
      process.env.LC_ALL = original.LC_ALL;
      process.env.LANG = original.LANG;
    }
  } finally {
    child.kill?.("SIGKILL");
  }
});
