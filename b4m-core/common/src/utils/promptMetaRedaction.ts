/**
 * promptMeta.functionCalls fields that must never reach a viewer who only holds a
 * "read this conversation" grant - a session share, a live subscription, a bug-report
 * egress to a third party (Slack/email), or a session clone made by a share holder
 * (b4m-core/services/src/sessionService/clone.ts, which copies quest.promptMeta wholesale
 * onto a session the sharee then OWNS - a share/subscribe grant must not become a durable
 * unredacted copy just because the copy has a new owner).
 *
 * `returnValue` is the verbatim output of a tool call the OWNER's turn made - up to 8000 chars
 * per call (see recordToolResult.ts) - and a tool can read the owner's private corpus, files, or
 * connected integrations. A share/subscribe grant authorizes reading the conversation the owner
 * had, not re-reading whatever the owner's tools touched on the owner's behalf. `error` is
 * currently unwritten but carries the same class of content on the failure path, so it is
 * redacted alongside it.
 *
 * This list is the single source of truth: add a field here and every response boundary that
 * routes through {@link redactFunctionCallsForViewer} inherits the redaction - PROVIDED the field
 * is a top-level, directly-owned-content field like these two. The redaction itself is a shallow
 * `delete` per field (see below), so a future owner-only value nested inside another field (e.g. a
 * private blob inside `parameters`) would NOT be caught by adding its name here; that shape needs
 * its own per-field handling, not just a new entry in this array.
 *
 * Adjacent unredacted shape, not yet a leak: `promptMeta.executionTracking.steps[].result`/
 * `.error` (PromptMetaZodSchema) are the same class of owner-only content but nothing writes them
 * today, so there is nothing to redact yet. A future writer landing there bypasses this list
 * entirely unless it is added here too.
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

type RedactableCitable = { metadata?: Record<string, unknown> | null } | null | undefined;

type RedactablePromptMeta = {
  functionCalls?: RedactableFunctionCall[] | null;
  citables?: RedactableCitable[] | null;
};

/**
 * Verbatim retrieved passage text on a citation chip (#3038). Owner-only for exactly the reason
 * `returnValue` is: it is a slice of a document the OWNER's retrieval read on the owner's behalf,
 * and a share/subscribe/clone grant authorizes reading the conversation, not re-reading the
 * owner's corpus through it. The sibling `chunkId` is deliberately kept - an opaque id is not
 * content, and `citables[].id` (the file id) is already unredacted beside it.
 */
const OWNER_ONLY_CITABLE_METADATA_FIELDS = ['fullContext'] as const;

/**
 * Strip owner-only metadata from citation chips for a non-owner viewer.
 *
 * Copies at both levels it edits - the array, and the `metadata` of a chip that actually carries
 * one of the fields - and MUST NOT mutate the input, for the same reason
 * {@link redactFunctionCallsForViewer} must not: read paths share the in-memory document between
 * an owner-scoped consumer and a client-response boundary.
 *
 * Returns the INPUT array when no chip carried a redactable field, which is what lets the caller
 * keep its documented same-reference contract on the common case: a file-level citation (keyword
 * search, whole-document retrieve) carries no passage text at all.
 */
function redactCitablesForViewer<T extends RedactableCitable>(citables: T[]): T[] {
  let redactedAny = false;
  const out = citables.map(citable => {
    if (!citable?.metadata) return citable;
    if (!OWNER_ONLY_CITABLE_METADATA_FIELDS.some(field => field in citable.metadata!)) return citable;
    redactedAny = true;
    const metadata = { ...citable.metadata };
    for (const field of OWNER_ONLY_CITABLE_METADATA_FIELDS) {
      delete metadata[field];
    }
    return { ...citable, metadata };
  });
  return redactedAny ? out : citables;
}

/**
 * The one place a whole `promptMeta` is redacted for a non-owner viewer: the owner sees it whole,
 * everyone else loses `functionCalls[].returnValue`/`.error` and `citables[].metadata.fullContext`.
 * This is the shape every quest-returning route needs - inherit it here rather than re-deriving
 * the per-field handling at the next route.
 *
 * Returns the SAME reference when `isOwner` is true or there is nothing to redact, so callers
 * that check reference equality (or just don't want a needless copy) are unaffected.
 */
export function redactPromptMetaForViewer<T extends RedactablePromptMeta>(
  promptMeta: T | null | undefined,
  isOwner: boolean
): T | null | undefined {
  if (isOwner || promptMeta == null) return promptMeta;
  const citables = promptMeta.citables ? redactCitablesForViewer(promptMeta.citables) : undefined;
  // functionCalls always copies when present, so its mere presence is a change; citables only
  // counts as one when a chip actually lost a field.
  if (!promptMeta.functionCalls && citables === promptMeta.citables) return promptMeta;
  return {
    ...promptMeta,
    ...(promptMeta.functionCalls ? { functionCalls: redactFunctionCallsForViewer(promptMeta.functionCalls) } : {}),
    ...(citables ? { citables } : {}),
  };
}
