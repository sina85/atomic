import type { CreateAgentSessionOptions } from "@bastani/atomic";
import type { WorkflowModelCatalogPort, WorkflowModelInfo, WorkflowModelValue } from "../../shared/types.js";

export interface ExplicitCursorReference {
  readonly fullId: string;
  readonly routeId: string;
}

export function parseExplicitCursorReference(rawInput: string): ExplicitCursorReference | undefined {
  if (!rawInput.startsWith("cursor/")) return undefined;
  const routeId = rawInput.slice("cursor/".length);
  return { fullId: rawInput, routeId };
}


export function strictCursorStringReference(rawInput: string): boolean {
  // Only an explicit lowercase `cursor/<bytes>` reference reserves authenticated
  // Cursor discovery; Cursor exposes no static executable catalog, so bare ids
  // are ordinary non-Cursor references.
  return parseExplicitCursorReference(rawInput) !== undefined;
}

export function explicitCursorModelObject(value: WorkflowModelValue | undefined): boolean {
  return value !== undefined && typeof value !== "string" && value.provider === "cursor";
}

interface CursorObjectRoutingCompat {
  readonly cursorRouting?: Readonly<Record<string, { readonly modelId: string; readonly catalogOccurrence: number }>>;
}

/**
 * The private per-ID occurrence ordinal a selected Cursor model object carries
 * on its own `compat.cursorRouting`, guarded like the execution authority so a
 * mismatched routing key cannot fabricate an occurrence. Returns `undefined`
 * when the object carries no valid ordinal for its exact id.
 */
export function cursorObjectOccurrence(value: NonNullable<CreateAgentSessionOptions["model"]>): number | undefined {
  const compat = value.compat as CursorObjectRoutingCompat | undefined;
  const routing = compat?.cursorRouting?.[value.id];
  if (routing?.modelId !== value.id) return undefined;
  // Use the caller ordinal ONLY when structurally valid: a non-negative
  // integer. TypeScript types disappear at runtime, so a malformed value (a
  // numeric string, fractional, negative, NaN, or Infinity) must be treated as
  // absent so selection falls back to the first live occurrence rather than
  // indexing an arbitrary live row.
  const occurrence = routing.catalogOccurrence;
  return Number.isInteger(occurrence) && occurrence >= 0 ? occurrence : undefined;
}

export function liveInfoCursorOccurrence(info: WorkflowModelInfo): number | undefined {
  return info.model ? cursorObjectOccurrence(info.model) : undefined;
}

export function hasStrictCursorReference(input: {
  readonly primaryModel?: WorkflowModelValue;
  readonly fallbackModels?: readonly string[];
}): boolean {
  return explicitCursorModelObject(input.primaryModel)
    || (typeof input.primaryModel === "string" && strictCursorStringReference(input.primaryModel))
    || (input.fallbackModels?.some(strictCursorStringReference) ?? false);
}

const AUTHENTICATED_CURSOR_DISCOVERY_UNAVAILABLE =
  "workflows: authenticated Cursor model discovery is unavailable";

export async function requireAuthenticatedCursorDiscovery(
  catalog: WorkflowModelCatalogPort | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (catalog?.discoverModels === undefined) {
    throw new Error(AUTHENTICATED_CURSOR_DISCOVERY_UNAVAILABLE);
  }
  await catalog.discoverModels(signal);
}
