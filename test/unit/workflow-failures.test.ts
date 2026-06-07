/**
 * Unit tests for workflow-local failure classification.
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  WORKFLOW_AUTH_FAILURE_MESSAGE,
  classifyWorkflowFailure,
} from "../../packages/workflows/src/shared/workflow-failures.js";

describe("classifyWorkflowFailure", () => {
  test("normalizes auth/no-key failures to workflow login guidance", () => {
    const failure = classifyWorkflowFailure(new Error("No API key found for provider"));
    assert.equal(failure.kind, "auth");
    assert.equal(failure.userMessage, WORKFLOW_AUTH_FAILURE_MESSAGE);
    assert.equal(failure.message, "No API key found for provider");
    assert.equal(failure.code, "missing_api_key");
    assert.equal(failure.recoverability, "recoverable");
    assert.equal(failure.disposition, "terminal_failed");
    assert.equal(failure.retryable, true);
    assert.equal(failure.resumable, true);
  });

  test("classifies 429/quota failures as resumable rate limits", () => {
    const failure = classifyWorkflowFailure(new Error("HTTP 429 quota exceeded"));
    assert.equal(failure.kind, "rate_limit");
    assert.equal(failure.userMessage, "HTTP 429 quota exceeded");
    assert.equal(failure.retryable, true);
    assert.equal(failure.resumable, true);
  });

  test("classifies abort errors as non-resumable cancellation", () => {
    const failure = classifyWorkflowFailure(new DOMException("workflow killed", "AbortError"));
    assert.equal(failure.kind, "cancelled");
    assert.equal(failure.retryable, false);
    assert.equal(failure.resumable, false);
  });

  test("classifies provider/model outages separately from auth", () => {
    const failure = classifyWorkflowFailure(new Error("model provider service unavailable"));
    assert.equal(failure.kind, "provider");
    assert.equal(failure.retryable, true);
    assert.equal(failure.resumable, true);
  });

  test("uses structured HTTP statuses before message fallback", () => {
    const auth = classifyWorkflowFailure({ message: "request failed", status: 401 });
    assert.equal(auth.kind, "auth");
    assert.equal(auth.userMessage, WORKFLOW_AUTH_FAILURE_MESSAGE);

    const rateLimit = classifyWorkflowFailure({ message: "request failed", statusCode: 429 });
    assert.equal(rateLimit.kind, "rate_limit");
    assert.equal(rateLimit.retryable, true);

    const provider = classifyWorkflowFailure({ message: "request failed", status: 503 });
    assert.equal(provider.kind, "provider");
    assert.equal(provider.retryable, true);

    const notImplemented = classifyWorkflowFailure({ message: "request failed", status: 501 });
    assert.equal(notImplemented.kind, "provider");
    assert.equal(notImplemented.retryable, true);
  });

  test("uses structured codes and causes before message fallback", () => {
    const auth = classifyWorkflowFailure({ message: "provider error", code: "AUTH_REQUIRED" });
    assert.equal(auth.kind, "auth");

    const rateLimit = classifyWorkflowFailure(new Error("outer failure", {
      cause: { message: "inner failure", code: "rate_limit_exceeded" },
    }));
    assert.equal(rateLimit.kind, "rate_limit");

    const cancelled = classifyWorkflowFailure({ message: "stopped", code: "AbortError" });
    assert.equal(cancelled.kind, "cancelled");
  });

  test("uses SDK assistant error shapes", () => {
    const failure = classifyWorkflowFailure({
      role: "assistant",
      stopReason: "error",
      errorMessage: "provider request failed",
      diagnostics: [{ error: { code: 429, message: "quota exceeded" } }],
    });
    assert.equal(failure.kind, "rate_limit");
    assert.equal(failure.message, "provider request failed");
    assert.equal(failure.code, "429");

    const cancelled = classifyWorkflowFailure({
      role: "assistant",
      stopReason: "aborted",
      errorMessage: "stream aborted",
    });
    assert.equal(cancelled.kind, "cancelled");
  });

  test("traverses nested diagnostics, response/body and cycles with bounded classification", () => {
    const body: Record<string, unknown> = { error: { status: 501 } };
    const response: Record<string, unknown> = { body };
    body["cause"] = response;

    const failure = classifyWorkflowFailure({
      message: "outer failure",
      diagnostics: [{ response }],
    });

    assert.equal(failure.kind, "provider");
    assert.equal(failure.retryable, true);
  });

  test("redacts obvious credentials from persisted and workflow-facing messages", () => {
    const message = "provider failed Authorization: Bearer sk-secret apiKey=abc123 token 'tok_secret_12345'";
    const failure = classifyWorkflowFailure({ message, status: 503, retryAfterMs: 2500 });

    assert.equal(failure.kind, "provider");
    assert.equal(failure.code, "503");
    assert.equal(failure.retryAfterMs, 2500);
    assert.doesNotMatch(failure.message, /sk-secret|abc123|tok_secret_12345/);
    assert.doesNotMatch(failure.userMessage, /sk-secret|abc123|tok_secret_12345/);
    assert.match(failure.message, /Authorization: \[REDACTED\]/i);
    assert.match(failure.userMessage, /Authorization: \[REDACTED\]/i);
  });

  test("redacts bare provider API keys on invalid-key failures", () => {
    const failure = classifyWorkflowFailure({
      status: 401,
      code: "invalid_api_key",
      message: "Incorrect API key provided: sk-testsecret123456789",
    });

    assert.equal(failure.kind, "auth");
    assert.equal(failure.code, "invalid_api_key");
    assert.equal(failure.recoverability, "non_recoverable");
    assert.equal(failure.retryable, false);
    assert.equal(failure.resumable, false);
    assert.equal(failure.message, "Incorrect API key provided: [REDACTED]");
    assert.equal(failure.userMessage, "Incorrect API key provided: [REDACTED]");
    assert.doesNotMatch(failure.message, /sk-testsecret123456789/);
    assert.doesNotMatch(failure.userMessage, /sk-testsecret123456789/);
  });

  test("classifies plain incorrect API key messages as terminal auth failures", () => {
    const failure = classifyWorkflowFailure(new Error("Incorrect API key provided: sk-testsecret123456789"));

    assert.equal(failure.kind, "auth");
    assert.equal(failure.code, "invalid_api_key");
    assert.equal(failure.recoverability, "non_recoverable");
    assert.equal(failure.retryable, false);
    assert.equal(failure.resumable, false);
    assert.equal(failure.message, "Incorrect API key provided: [REDACTED]");
    assert.equal(failure.userMessage, "Incorrect API key provided: [REDACTED]");
  });

  test("nested concrete provider codes outrank generic wrapper statuses", () => {
    const invalidKey = classifyWorkflowFailure({
      status: 401,
      message: "request failed",
      body: {
        error: {
          code: "invalid_api_key",
          message: "Incorrect API key provided: sk-testsecret123456789",
        },
      },
    });
    assert.equal(invalidKey.kind, "auth");
    assert.equal(invalidKey.code, "invalid_api_key");
    assert.equal(invalidKey.recoverability, "non_recoverable");
    assert.equal(invalidKey.resumable, false);
    assert.doesNotMatch(invalidKey.message, /sk-testsecret123456789/);

    const missingModel = classifyWorkflowFailure({
      status: 404,
      message: "request failed",
      body: { error: { code: "model_not_found", message: "configured model does not exist" } },
    });
    assert.equal(missingModel.kind, "provider");
    assert.equal(missingModel.code, "model_not_found");
    assert.equal(missingModel.recoverability, "non_recoverable");
    assert.equal(missingModel.resumable, false);
  });

  test("traverses AggregateError inner failures with terminal failures winning", () => {
    const rateLimit = classifyWorkflowFailure(new AggregateError([
      { status: 429, message: "too many requests" },
    ], "parallel failed"));
    assert.equal(rateLimit.kind, "rate_limit");
    assert.equal(rateLimit.recoverability, "recoverable");
    assert.equal(rateLimit.resumable, true);

    const mixed = classifyWorkflowFailure(new AggregateError([
      { status: 429, message: "too many requests" },
      { message: "Incorrect API key provided: sk-testsecret123456789" },
    ], "parallel failed"));
    assert.equal(mixed.kind, "auth");
    assert.equal(mixed.code, "invalid_api_key");
    assert.equal(mixed.recoverability, "non_recoverable");
    assert.equal(mixed.resumable, false);
    assert.doesNotMatch(mixed.message, /sk-testsecret123456789/);
  });

  test("preserves Retry-After metadata from common provider shapes", () => {
    const retryAt = new Date(Date.now() + 1_500).toUTCString();
    for (const [error, expectedMinimum] of [
      [{ status: 429, headers: { "retry-after": "2" } }, 2_000],
      [{ status: 429, retryAfterSeconds: 2 }, 2_000],
      [{ status: 429, "retry-after": "2" }, 2_000],
      [{ status: 429, response: { headers: { "retry-after": "2" } } }, 2_000],
      [{ status: 429, headers: { "retry-after": retryAt } }, 0],
    ] as const) {
      const failure = classifyWorkflowFailure(error);
      assert.equal(failure.kind, "rate_limit");
      assert.equal(typeof failure.retryAfterMs, "number");
      assert.ok((failure.retryAfterMs ?? 0) >= expectedMinimum);
    }
  });

  test("does not treat log information/input errors as auth failures", () => {
    for (const message of [
      "failed to log information about request",
      "failed to log input before validation",
    ]) {
      const failure = classifyWorkflowFailure(new Error(message));
      assert.equal(failure.kind, "unknown");
      assert.equal(failure.userMessage, message);
      assert.equal(failure.retryable, false);
    }
  });

  test("still treats bounded log in guidance as auth failure", () => {
    const failure = classifyWorkflowFailure(new Error("Please log in to continue"));
    assert.equal(failure.kind, "auth");
    assert.equal(failure.userMessage, WORKFLOW_AUTH_FAILURE_MESSAGE);
  });

  test("does not treat generic domain/tool model errors as provider outages", () => {
    for (const message of [
      "domain model validation failed",
      "invalid model parameter passed to tool",
    ]) {
      const failure = classifyWorkflowFailure(new Error(message));
      assert.equal(failure.kind, "unknown");
      assert.equal(failure.retryable, false);
    }
  });

  test("treats missing/nonexistent model configuration as non-recoverable", () => {
    for (const message of ["model not found", "nonexistent model configured"]) {
      const failure = classifyWorkflowFailure(new Error(message));
      assert.equal(failure.kind, "provider");
      assert.equal(failure.code, "model_not_found");
      assert.equal(failure.recoverability, "non_recoverable");
      assert.equal(failure.retryable, false);
      assert.equal(failure.resumable, false);
    }
  });

  test("keeps transient provider and rate-limit failures recoverable", () => {
    for (const message of ["model unavailable", "provider overloaded", "service unavailable 503", "rate limit 429"]) {
      const failure = classifyWorkflowFailure(new Error(message));
      assert.equal(failure.recoverability, "recoverable");
      assert.equal(failure.retryable, true);
      assert.equal(failure.resumable, true);
    }
  });

  test("keeps invalid tokens, forbidden access, and model access failures non-recoverable", () => {
    for (const error of [
      new Error("invalid token provided"),
      { status: 403, message: "request forbidden" },
      new Error("model access denied"),
    ]) {
      const failure = classifyWorkflowFailure(error);
      assert.equal(failure.kind, "auth");
      assert.equal(failure.recoverability, "non_recoverable");
      assert.equal(failure.retryable, false);
      assert.equal(failure.resumable, false);
    }
  });

  test("does not treat generic OAuth metadata errors as auth failures", () => {
    const failure = classifyWorkflowFailure(new Error("OAuth callback metadata parse failed"));
    assert.equal(failure.kind, "unknown");
    assert.equal(failure.userMessage, "OAuth callback metadata parse failed");
  });

  test("still treats OAuth token errors as auth failures", () => {
    const failure = classifyWorkflowFailure(new Error("OAuth token expired"));
    assert.equal(failure.kind, "auth");
    assert.equal(failure.userMessage, WORKFLOW_AUTH_FAILURE_MESSAGE);
  });
});
