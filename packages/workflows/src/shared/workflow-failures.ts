import type { WorkflowFailureCode, WorkflowFailureDisposition, WorkflowFailureKind, WorkflowFailureRecoverability } from "./store-types.js";

export interface WorkflowFailure {
  readonly kind: WorkflowFailureKind;
  /** Redacted diagnostic text safe for run/stage snapshots and persistence. */
  readonly message: string;
  /** Redacted workflow-facing text shown on run/stage snapshots. */
  readonly userMessage: string;
  readonly code?: WorkflowFailureCode;
  readonly recoverability: WorkflowFailureRecoverability;
  readonly disposition: WorkflowFailureDisposition;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly resumable: boolean;
  readonly cause?: unknown;
}

export const WORKFLOW_AUTH_FAILURE_MESSAGE =
  "You must be logged in to run workflows. Run /login and try again.";

const WORKFLOW_FAILURE_KINDS: ReadonlySet<WorkflowFailureKind> = new Set([
  "auth",
  "rate_limit",
  "provider",
  "cancelled",
  "unknown",
]);

export function isWorkflowFailureKind(kind: string): kind is WorkflowFailureKind {
  return WORKFLOW_FAILURE_KINDS.has(kind as WorkflowFailureKind);
}

const REDACTED_CREDENTIAL = "[REDACTED]";
const SECRET_KEY_FRAGMENT = String.raw`(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|secret|token|password|credential)`;
const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`(["']?)([A-Za-z0-9_.-]*${SECRET_KEY_FRAGMENT}[A-Za-z0-9_.-]*)(\1)(\s*[:=]\s*)(["']?)([^"'\s,;}\]]+)\5`,
  "gi",
);
const AUTHORIZATION_HEADER_PATTERN = /\b(authorization\s*[:=]\s*)(?:bearer\s+)?([^\s,;]+)/gi;
const BEARER_TOKEN_PATTERN = /\bbearer\s+([A-Za-z0-9._~+/=-]{8,})/gi;
const SECRET_CONTEXT_VALUE_PATTERN = new RegExp(
  String.raw`(\b(?:api\s*key|auth(?:orization)?\s*token|access\s*token|refresh\s*token|client\s*secret|secret|token)\b(?:\s+(?:provided|supplied|value|is|was))?\s*(?::|=)?\s*)(["']?)(?!(?:provided|supplied|expired|invalid|required|missing|not|found)\b)([A-Za-z0-9._~+/=-]{8,})\2`,
  "gi",
);
const BARE_PROVIDER_KEY_PATTERN = /\b(?:sk|rk|pk)-[A-Za-z0-9][A-Za-z0-9_-]{5,}\b/g;

function redactCredentials(message: string): string {
  return message
    .replace(AUTHORIZATION_HEADER_PATTERN, `$1${REDACTED_CREDENTIAL}`)
    .replace(BEARER_TOKEN_PATTERN, `Bearer ${REDACTED_CREDENTIAL}`)
    .replace(SECRET_ASSIGNMENT_PATTERN, `$1$2$3$4$5${REDACTED_CREDENTIAL}$5`)
    .replace(SECRET_CONTEXT_VALUE_PATTERN, `$1$2${REDACTED_CREDENTIAL}$2`)
    .replace(BARE_PROVIDER_KEY_PATTERN, REDACTED_CREDENTIAL);
}

function makeWorkflowFailure(
  kind: WorkflowFailureKind,
  message: string,
  opts: {
    readonly retryable: boolean;
    readonly resumable: boolean;
    readonly cause: unknown;
    readonly userMessage?: string;
    readonly code?: WorkflowFailureCode;
    readonly retryAfterMs?: number;
  },
): WorkflowFailure {
  const redactedMessage = redactCredentials(message);
  return {
    kind,
    message: redactedMessage,
    userMessage: redactCredentials(opts.userMessage ?? message),
    ...(opts.code !== undefined ? { code: opts.code } : {}),
    recoverability: kind === "unknown" ? "unknown" : opts.resumable ? "recoverable" : "non_recoverable",
    disposition: kind === "cancelled" ? "terminal_killed" : "terminal_failed",
    ...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
    retryable: opts.retryable,
    resumable: opts.resumable,
    cause: opts.cause,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function field(value: unknown, key: string): unknown {
  return asRecord(value)?.[key];
}

function stringField(value: unknown, key: string): string | undefined {
  const raw = field(value, key);
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function errorMessage(error: unknown): string {
  const structuredMessage = structuredErrorMessage(error);
  if (structuredMessage !== undefined) return structuredMessage;
  if (error instanceof Error && typeof error.message === "string") return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : stringField(error, "name");
}

function structuredErrorMessage(error: unknown): string | undefined {
  return stringField(error, "errorMessage")
    ?? stringField(error, "message")
    ?? stringField(error, "statusText");
}

type StructuredSignal = {
  readonly status?: number;
  readonly code?: string | number;
  readonly name?: string;
  readonly stopReason?: string;
  readonly retryAfterMs?: number;
  readonly message?: string;
};

function integerFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) ? parsed : undefined;
}

function structuredSignal(error: unknown): StructuredSignal {
  const status = integerFrom(field(error, "status"))
    ?? integerFrom(field(error, "statusCode"))
    ?? integerFrom(field(error, "httpStatus"));
  const rawCode = field(error, "code");
  const code = typeof rawCode === "string" || typeof rawCode === "number" ? rawCode : undefined;
  const name = errorName(error);
  const stopReason = stringField(error, "stopReason");
  const retryAfterMs = retryAfterMsFromSignal(error);
  const message = structuredErrorMessage(error);
  return {
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

function causeOf(error: unknown): unknown {
  if (error instanceof Error) return error.cause;
  return field(error, "cause");
}

const STRUCTURED_KIND_MAX_DEPTH = 8;
const STRUCTURED_NESTED_KEYS = ["errors", "diagnostics", "cause", "error", "response", "body"] as const;

function nestedStructuredValues(error: unknown): readonly unknown[] {
  const values: unknown[] = [];
  for (const key of STRUCTURED_NESTED_KEYS) {
    const value = key === "cause" ? causeOf(error) : field(error, key);
    if (value === undefined || value === null) continue;
    if (key === "diagnostics" && Array.isArray(value)) {
      for (const diagnostic of value) {
        const diagnosticError = field(diagnostic, "error");
        values.push(diagnosticError ?? diagnostic);
      }
      continue;
    }
    values.push(value);
  }
  return values;
}

function normalizeCode(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return String(value).trim().toLowerCase().replaceAll("-", "_");
}

function kindFromStatus(status: number | undefined): WorkflowFailureKind | undefined {
  switch (status) {
    case 401:
    case 403:
      return "auth";
    case 429:
      return "rate_limit";
    case 500:
    case 501:
    case 502:
    case 503:
    case 504:
      return "provider";
    default:
      return undefined;
  }
}

function kindFromCode(code: string | number | undefined): WorkflowFailureKind | undefined {
  const normalized = normalizeCode(code);
  switch (normalized) {
    case undefined:
      return undefined;
    case "401":
    case "403":
    case "auth":
    case "auth_required":
    case "authentication_required":
    case "unauthorized":
    case "forbidden":
    case "permission_denied":
    case "invalid_api_key":
    case "invalid_token":
    case "invalid_auth_token":
    case "invalid_access_token":
    case "model_access_denied":
    case "model_not_allowed":
    case "missing_api_key":
      return "auth";
    case "429":
    case "rate_limit":
    case "rate_limit_exceeded":
    case "too_many_requests":
    case "quota_exceeded":
      return "rate_limit";
    case "aborterror":
    case "aborted":
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "500":
    case "501":
    case "502":
    case "503":
    case "504":
    case "provider_error":
    case "service_unavailable":
    case "temporarily_unavailable":
    case "overloaded":
    case "model_not_found":
    case "model_not_exist":
    case "model_does_not_exist":
    case "nonexistent_model":
      return "provider";
    default:
      return undefined;
  }
}

function retryAfterMsFromRetryAfter(value: unknown): number | undefined {
  const integer = integerFrom(value);
  if (integer !== undefined) return integer > 0 ? integer * 1000 : 0;
  if (typeof value !== "string") return undefined;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function retryAfterMsFromHeaders(headers: unknown): number | undefined {
  if (headers instanceof Headers) return retryAfterMsFromRetryAfter(headers.get("retry-after"));
  const record = asRecord(headers);
  if (record === undefined) return undefined;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === "retry-after") return retryAfterMsFromRetryAfter(value);
  }
  return undefined;
}

function retryAfterMsFromSignal(error: unknown): number | undefined {
  return integerFrom(field(error, "retryAfterMs"))
    ?? retryAfterMsFromRetryAfter(field(error, "retryAfter"))
    ?? retryAfterMsFromRetryAfter(field(error, "retryAfterSeconds"))
    ?? retryAfterMsFromRetryAfter(field(error, "retry-after"))
    ?? retryAfterMsFromHeaders(field(error, "headers"));
}

function hasStructuredSignalContent(signal: StructuredSignal): boolean {
  return signal.status !== undefined
    || signal.code !== undefined
    || signal.name !== undefined
    || signal.stopReason !== undefined
    || signal.retryAfterMs !== undefined
    || signal.message !== undefined;
}

function collectStructuredSignals(error: unknown, seen = new Set<unknown>(), depth = 0): readonly StructuredSignal[] {
  if (error === undefined || error === null || depth > STRUCTURED_KIND_MAX_DEPTH) return [];
  if (typeof error === "string") return [{ message: error }];
  if (typeof error === "number") return [{ code: error }];
  if (typeof error !== "object") return [];
  if (seen.has(error)) return [];
  seen.add(error);

  const signals: StructuredSignal[] = [];
  if (Array.isArray(error)) {
    for (const item of error) signals.push(...collectStructuredSignals(item, seen, depth + 1));
    return signals;
  }

  const signal = structuredSignal(error);
  if (hasStructuredSignalContent(signal)) signals.push(signal);
  for (const nested of nestedStructuredValues(error)) {
    signals.push(...collectStructuredSignals(nested, seen, depth + 1));
  }
  return signals;
}

function workflowFailureCode(kind: WorkflowFailureKind, signal: StructuredSignal | undefined, message: string): WorkflowFailureCode | undefined {
  const normalizedCode = normalizeCode(signal?.code);
  if (normalizedCode !== undefined) return normalizedCode;
  if (signal?.status !== undefined) return String(signal.status);
  const normalizedName = signal?.name === "Error" ? undefined : normalizeCode(signal?.name);
  if (normalizedName !== undefined) return normalizedName;
  const tokens = tokenize([message, signal?.message].filter((part) => part !== undefined).join("\n"));
  if (kind === "auth") {
    if (hasAnyPhrase(tokens, [["missing", "api", "key"], ["no", "api", "key"], ["api", "key", "not", "found"]])) return "missing_api_key";
    if (tokensNear(tokens, "invalid", "token", 4)) return "invalid_token";
    if (tokenNearAny(tokens, "invalid", SECRET_FIELD_TOKENS, 4) || hasPhrase(tokens, ["incorrect", "api", "key"])) return "invalid_api_key";
    if (hasAnyPhrase(tokens, [["model", "access", "forbidden"], ["model", "access", "denied"]])) return "model_access_denied";
    return "auth_required";
  }
  if (kind === "rate_limit") return "rate_limited";
  if (kind === "provider") {
    if (isMissingModelConfiguration(tokens, normalizeCode(signal?.code))) return "model_not_found";
    return "provider_unavailable";
  }
  if (kind === "cancelled") return "cancelled";
  return undefined;
}

function signalKind(signal: StructuredSignal): WorkflowFailureKind | undefined {
  if (signal.stopReason?.toLowerCase() === "aborted") return "cancelled";
  return kindFromCode(signal.code)
    ?? kindFromCode(signal.name)
    ?? kindFromStatus(signal.status)
    ?? (signal.message !== undefined ? fallbackKindFromMessage(signal.message, signal.name) : undefined);
}

function signalPriority(kind: WorkflowFailureKind, signal: StructuredSignal): number {
  const message = signal.message ?? "";
  const code = workflowFailureCode(kind, signal, message);
  const tokens = tokenize(message);
  if (kind === "cancelled") return 700;
  if (kind === "auth" && isNonRecoverableAuthFailure(tokens, signal, code)) return 600;
  if (kind === "provider" && isMissingModelConfiguration(tokens, normalizeCode(code) ?? normalizeCode(signal.code))) return 550;
  if (kind === "rate_limit") return 400;
  if (kind === "provider") return 300;
  if (kind === "auth") return 200;
  return 0;
}

function selectStructuredSignal(signals: readonly StructuredSignal[]): { readonly kind: WorkflowFailureKind; readonly signal: StructuredSignal } | undefined {
  let selected: { readonly kind: WorkflowFailureKind; readonly signal: StructuredSignal; readonly priority: number } | undefined;
  for (const signal of signals) {
    const kind = signalKind(signal);
    if (kind === undefined) continue;
    const priority = signalPriority(kind, signal);
    if (selected === undefined || priority > selected.priority) selected = { kind, signal, priority };
  }
  if (selected === undefined) return undefined;
  return { kind: selected.kind, signal: selected.signal };
}

function retryAfterMsFromSignals(signals: readonly StructuredSignal[]): number | undefined {
  for (const signal of signals) {
    if (signal.retryAfterMs !== undefined) return signal.retryAfterMs;
  }
  return undefined;
}

function signalWithRetryAfter(signal: StructuredSignal | undefined, retryAfterMs: number | undefined): StructuredSignal | undefined {
  if (signal === undefined) {
    return retryAfterMs !== undefined ? { retryAfterMs } : undefined;
  }
  if (signal.retryAfterMs !== undefined || retryAfterMs === undefined) return signal;
  return { ...signal, retryAfterMs };
}

function failureForKind(kind: WorkflowFailureKind, message: string, cause: unknown, signal: StructuredSignal | undefined): WorkflowFailure {
  const code = workflowFailureCode(kind, signal, message);
  const retryAfterMs = signal?.retryAfterMs;
  const tokens = tokenize([message, signal?.message].filter((part) => part !== undefined).join("\n"));
  switch (kind) {
    case "auth": {
      const nonRecoverable = isNonRecoverableAuthFailure(tokens, signal, code);
      return makeWorkflowFailure("auth", message, {
        ...(nonRecoverable ? {} : { userMessage: WORKFLOW_AUTH_FAILURE_MESSAGE }),
        retryable: !nonRecoverable,
        resumable: !nonRecoverable,
        cause,
        ...(code !== undefined ? { code } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
    case "rate_limit":
      return makeWorkflowFailure("rate_limit", message, {
        retryable: true,
        resumable: true,
        cause,
        ...(code !== undefined ? { code } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    case "cancelled":
      return makeWorkflowFailure("cancelled", message, {
        retryable: false,
        resumable: false,
        cause,
        ...(code !== undefined ? { code } : {}),
      });
    case "provider": {
      const nonRecoverable = isMissingModelConfiguration(tokens, normalizeCode(code) ?? normalizeCode(signal?.code));
      return makeWorkflowFailure("provider", message, {
        retryable: !nonRecoverable,
        resumable: !nonRecoverable,
        cause,
        ...(code !== undefined ? { code } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
    case "unknown":
      return makeWorkflowFailure("unknown", message, {
        retryable: false,
        resumable: true,
        cause,
        ...(code !== undefined ? { code } : {}),
      });
  }
}

type TokenMatch = readonly string[];

function tokenize(value: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  for (const char of value.toLowerCase()) {
    if ((char >= "a" && char <= "z") || (char >= "0" && char <= "9")) {
      current += char;
    } else if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function hasPhrase(tokens: readonly string[], phrase: TokenMatch): boolean {
  if (phrase.length === 0 || phrase.length > tokens.length) return false;
  for (let index = 0; index <= tokens.length - phrase.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < phrase.length; offset += 1) {
      if (tokens[index + offset] !== phrase[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function hasAnyPhrase(tokens: readonly string[], phrases: readonly TokenMatch[]): boolean {
  return phrases.some((phrase) => hasPhrase(tokens, phrase));
}

function tokenNearAny(tokens: readonly string[], anchor: string, candidates: ReadonlySet<string>, distance: number): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== anchor) continue;
    const start = Math.max(0, index - distance);
    const end = Math.min(tokens.length - 1, index + distance);
    for (let cursor = start; cursor <= end; cursor += 1) {
      if (cursor !== index && candidates.has(tokens[cursor]!)) return true;
    }
  }
  return false;
}

function tokensNear(tokens: readonly string[], left: string, right: string, distance: number): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== left) continue;
    const start = Math.max(0, index - distance);
    const end = Math.min(tokens.length - 1, index + distance);
    for (let cursor = start; cursor <= end; cursor += 1) {
      if (cursor !== index && tokens[cursor] === right) return true;
    }
  }
  return false;
}

function isMissingModelConfiguration(tokens: readonly string[], normalizedCode: string | undefined): boolean {
  if (normalizedCode !== undefined && [
    "model_not_found",
    "model_not_exist",
    "model_does_not_exist",
    "nonexistent_model",
  ].includes(normalizedCode)) return true;
  return hasAnyPhrase(tokens, [
    ["model", "not", "found"],
    ["model", "does", "not", "exist"],
    ["model", "doesn", "t", "exist"],
    ["nonexistent", "model"],
    ["unknown", "model"],
  ]) || (tokensNear(tokens, "model", "nonexistent", 3) || (tokensNear(tokens, "model", "found", 3) && tokens.includes("not")));
}

const NON_RECOVERABLE_AUTH_CODES = new Set([
  "403",
  "forbidden",
  "permission_denied",
  "invalid_api_key",
  "invalid_token",
  "invalid_auth_token",
  "invalid_access_token",
  "model_access_denied",
  "model_not_allowed",
]);
const MODEL_ACCESS_DENIED_TOKENS = new Set(["forbidden", "denied"]);
const SECRET_FIELD_TOKENS = new Set(["key", "token", "credential", "credentials"]);

function hasModelAccessFailure(tokens: readonly string[]): boolean {
  if (!tokens.includes("model") || !tokens.includes("access")) return false;
  if (tokenNearAny(tokens, "access", MODEL_ACCESS_DENIED_TOKENS, 4)) return true;
  return hasAnyPhrase(tokens, [
    ["do", "not", "have", "access", "to", "model"],
    ["does", "not", "have", "access", "to", "model"],
    ["don", "t", "have", "access", "to", "model"],
    ["no", "access", "to", "model"],
  ]);
}

function isNonRecoverableAuthFailure(tokens: readonly string[], signal: StructuredSignal | undefined, code: string | undefined): boolean {
  const normalizedCode = normalizeCode(code) ?? normalizeCode(signal?.code);
  if (signal?.status === 403 || (normalizedCode !== undefined && NON_RECOVERABLE_AUTH_CODES.has(normalizedCode))) return true;
  if (hasAnyPhrase(tokens, [
    ["forbidden"],
    ["invalid", "api", "key"],
    ["incorrect", "api", "key"],
    ["invalid", "token"],
    ["invalid", "auth", "token"],
    ["invalid", "access", "token"],
    ["invalid", "credential"],
    ["invalid", "credentials"],
    ["model", "access", "forbidden"],
    ["model", "access", "denied"],
  ])) return true;
  return tokenNearAny(tokens, "invalid", SECRET_FIELD_TOKENS, 4)
    || hasModelAccessFailure(tokens);
}

const AUTH_PHRASES: readonly TokenMatch[] = [
  ["no", "api", "key"],
  ["api", "key", "not", "found"],
  ["missing", "api", "key"],
  ["no", "model", "selected"],
  ["no", "models", "available"],
  ["not", "logged", "in"],
  ["log", "in"],
  ["login", "required"],
  ["authentication", "required"],
  ["unauthorized"],
  ["forbidden"],
  ["invalid", "api", "key"],
  ["incorrect", "api", "key"],
  ["invalid", "token"],
  ["invalid", "auth", "token"],
  ["invalid", "access", "token"],
  ["invalid", "credential"],
  ["invalid", "credentials"],
  ["model", "access", "forbidden"],
  ["model", "access", "denied"],
];

const RATE_LIMIT_PHRASES: readonly TokenMatch[] = [
  ["rate", "limit"],
  ["429"],
  ["quota"],
  ["too", "many", "requests"],
];

const CANCELLED_PHRASES: readonly TokenMatch[] = [
  ["aborted"],
  ["cancelled"],
  ["canceled"],
];

const PROVIDER_PHRASES: readonly TokenMatch[] = [
  ["model", "not", "found"],
  ["model", "does", "not", "exist"],
  ["model", "doesn", "t", "exist"],
  ["nonexistent", "model"],
  ["unknown", "model"],
  ["overloaded"],
  ["temporarily", "unavailable"],
  ["service", "unavailable"],
  ["503"],
];

const AUTH_CONTEXT = new Set([
  "token",
  "credential",
  "credentials",
  "required",
  "expired",
  "invalid",
  "missing",
  "unauthorized",
  "login",
  "signin",
]);

const MODEL_PROVIDER_CONTEXT = new Set([
  "unavailable",
  "overloaded",
  "temporarily",
  "service",
]);

const PROVIDER_CONTEXT = new Set([
  "error",
  "failure",
  "failed",
  "overloaded",
  "unavailable",
  "temporarily",
  "service",
]);

function fallbackKindFromMessage(message: string, name: string | undefined): WorkflowFailureKind | undefined {
  const tokens = tokenize(message);
  if (hasAnyPhrase(tokens, AUTH_PHRASES) || hasModelAccessFailure(tokens) || tokenNearAny(tokens, "oauth", AUTH_CONTEXT, 8)) return "auth";
  if (hasAnyPhrase(tokens, RATE_LIMIT_PHRASES)) return "rate_limit";
  if (name?.toLowerCase() === "aborterror" || hasAnyPhrase(tokens, CANCELLED_PHRASES)) return "cancelled";
  if (
    hasAnyPhrase(tokens, PROVIDER_PHRASES)
    || tokenNearAny(tokens, "model", MODEL_PROVIDER_CONTEXT, 8)
    || tokenNearAny(tokens, "provider", PROVIDER_CONTEXT, 8)
  ) return "provider";
  return undefined;
}

export function classifyWorkflowFailure(error: unknown): WorkflowFailure {
  const message = errorMessage(error);
  const signals = collectStructuredSignals(error);
  const retryAfterMs = retryAfterMsFromSignals(signals);
  const selected = selectStructuredSignal(signals);
  if (selected !== undefined) {
    return failureForKind(selected.kind, message, error, signalWithRetryAfter(selected.signal, retryAfterMs));
  }

  const fallback = fallbackKindFromMessage(message, errorName(error));
  if (fallback !== undefined) return failureForKind(fallback, message, error, signalWithRetryAfter(undefined, retryAfterMs));

  return failureForKind("unknown", message, error, signalWithRetryAfter(undefined, retryAfterMs));
}
