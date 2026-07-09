import { test } from "bun:test";
import assert from "node:assert/strict";
import { createWorkingVisibilityGuard } from "../../packages/workflows/src/tui/working-visibility-guard.ts";

test("working visibility guard hides and restores once", () => {
  const calls: boolean[] = [];
  const guard = createWorkingVisibilityGuard({
    setWorkingVisible: (visible) => calls.push(visible),
  });

  guard.restore();
  guard.hide();
  guard.restore();
  guard.restore();

  assert.deepEqual(calls, [false, true]);
});

test("working visibility guard swallows host visibility failures", () => {
  const calls: boolean[] = [];
  const guard = createWorkingVisibilityGuard({
    setWorkingVisible: (visible) => {
      calls.push(visible);
      throw new Error("stale host");
    },
  });

  assert.doesNotThrow(() => guard.hide());
  assert.doesNotThrow(() => guard.restore());
  assert.deepEqual(calls, [false]);
});
