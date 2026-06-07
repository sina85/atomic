import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildModelCandidates,
  currentModelFullId,
  isRetryableModelFailure,
  isRetryableProviderFailureSignal,
  providerFailureSignalText,
} from "../../packages/subagents/src/runs/shared/model-fallback.js";
import type { AvailableModelInfo } from "../../packages/subagents/src/runs/shared/model-fallback.js";

const models: AvailableModelInfo[] = [
  { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
  { provider: "github-copilot", id: "claude-sonnet-4", fullId: "github-copilot/claude-sonnet-4" },
  { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
];

describe("subagent model fallback helpers", () => {
  test("appends the current selected model after configured fallbacks", () => {
    assert.deepEqual(
      buildModelCandidates(
        "anthropic/primary",
        ["openai/fallback"],
        models,
        "github-copilot",
        "github-copilot/claude-sonnet-4",
      ),
      ["anthropic/primary", "openai/fallback", "github-copilot/claude-sonnet-4"],
    );
  });

  test("de-duplicates the current selected model when already attempted", () => {
    assert.deepEqual(
      buildModelCandidates(
        "claude-sonnet-4",
        ["openai/gpt-5-mini"],
        models,
        "github-copilot",
        "github-copilot/claude-sonnet-4",
      ),
      ["github-copilot/claude-sonnet-4", "openai/gpt-5-mini"],
    );
  });

  test("formats the selected model from the runtime model object", () => {
    assert.equal(
      currentModelFullId({ provider: "openai", id: "gpt-5-mini" }),
      "openai/gpt-5-mini",
    );
  });

  test("retries provider/model failures", () => {
    assert.equal(isRetryableModelFailure("rate limit from provider 429"), true);
    assert.equal(isRetryableModelFailure("model temporarily unavailable 503"), true);
    assert.equal(isRetryableModelFailure("provider returned 520"), true);
    assert.equal(isRetryableModelFailure("provider returned 529"), true);
    assert.equal(isRetryableModelFailure("provider returned 599"), true);
    for (const code of ["401", "403", "429", "500", "501", "502", "503", "504", "520", "529", "599"]) {
      assert.equal(isRetryableModelFailure(code), true, code);
    }
  });

  test("retries structured provider failure signals", () => {
    const signal = {
      status: 503,
      diagnostics: { message: "service unavailable" },
      stopReason: "error",
    };

    assert.equal(isRetryableProviderFailureSignal(signal), true);
    assert.equal(isRetryableProviderFailureSignal({ stopReason: "error" }), true);
    assert.equal(isRetryableProviderFailureSignal({ status: 520 }), true);
    assert.equal(isRetryableProviderFailureSignal({ status: 599 }), true);
    assert.match(providerFailureSignalText(signal) ?? "", /503/);
    assert.match(providerFailureSignalText(signal) ?? "", /service unavailable/);
  });

  test("retries nested structured provider/auth/rate-limit diagnostics", () => {
    const signal = {
      diagnostics: [
        {
          response: {
            body: {
              error: { status: 401 },
            },
          },
        },
      ],
      stopReason: "error",
    };

    assert.equal(isRetryableProviderFailureSignal(signal), true);
    assert.match(providerFailureSignalText(signal) ?? "", /401/);
  });

  test("does not retry local failures even when they contain retryable-looking codes", () => {
    for (const message of [
      "command failed: curl returned 503",
      "shell failed with 429",
      "shell exited with 429",
      "tool call failed: service unavailable",
      "task failed after provider returned 502",
      "tests failed with 504",
      "completion guard failed with 503",
      "aborted after provider returned 503",
      "cancelled after provider returned 520",
      "interrupted after provider returned 529",
      "missing file from 503 response",
      "no such file from 599 response",
    ]) {
      assert.equal(isRetryableModelFailure(message), false, message);
    }
    assert.equal(isRetryableProviderFailureSignal({ stopReason: "aborted", status: 503 }), false);
    assert.equal(isRetryableProviderFailureSignal({ message: "missing file", status: 503 }), false);
    assert.equal(isRetryableModelFailure("error"), false);
  });
});
