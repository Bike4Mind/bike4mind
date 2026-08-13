/**
 * promptMeta.functionCalls fields that must never reach a viewer who only holds a
 * "read this conversation" grant - a session share, a live subscription, or a bug-report
 * egress to a third party (Slack/email).
 *
 * `returnValue` is the verbatim output of a tool call the OWNER's turn made - up to 8000 chars
 * per call (see recordToolResult.ts) - and a tool can read the owner's private corpus, files, or
 * connected integrations. A share/subscribe grant authorizes reading the conversation the owner
 * had, not re-reading whatever the owner's tools touched on the owner's behalf. `error` is
 * currently unwritten but carries the same class of content on the failure path, so it is
 * redacted alongside it.
 *
 * This list is the single source of truth: add a field here and every response boundary that
 * routes through {@link redactFunctionCallsForViewer} inherits the redaction.
 */
export const OWNER_ONLY_FUNCTION_CALL_FIELDS = ['returnValue', 'error'] as const;

export type OwnerOnlyFunctionCallField = (typeof OWNER_ONLY_FUNCTION_CALL_FIELDS)[number];

type RedactableFunctionCall = Partial<Record<OwnerOnlyFunctionCallField, unknown>>;

/**
 * Strip owner-only fields from a functionCalls array for a non-owner viewer.
 *
 * Returns a SHALLOW COPY with the fields removed - it MUST NOT mutate the input, matching
 * {@link redactSessionForClient}'s contract for the same reason: some read paths share the
 * in-memory document between an owner-scoped consumer and a client-response boundary.
 *
 * Null/undefined pass through unchanged so callers can redact optional results directly.
 */
export function redactFunctionCallsForViewer<T extends RedactableFunctionCall>(
  functionCalls: T[] | null | undefined
): Omit<T, OwnerOnlyFunctionCallField>[] | null | undefined {
  if (functionCalls == null) return functionCalls;
  return functionCalls.map(fc => {
    const redacted = { ...fc };
    for (const field of OWNER_ONLY_FUNCTION_CALL_FIELDS) {
      delete redacted[field];
    }
    return redacted;
  });
}
