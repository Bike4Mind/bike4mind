/**
 * Which registry prompts a SESSION may activate, and whether a session carries its own authored
 * prompt at all.
 *
 * Lives in its own module rather than in `chatCompletionDefaults` for two reasons: this is an
 * authorization policy rather than a completion default, and `chatCompletionDefaults` reads SST
 * `Resource` bindings, so anything declared there cannot be unit-tested without a deploy context.
 * The allowlist is what stands between a client-settable prompt ID and an injected REGISTRY prompt,
 * so it needs to be testable.
 *
 * Scope, stated precisely because the narrower claim is the true one: this governs `systemPromptId`
 * only. The sibling field `systemPromptText` is ALSO accepted from the client by
 * `createSessionParametersSchema` and is injected verbatim with no allowlist and no resolver - so
 * this is not the only route to an authored session prompt, and it is not a general defence against
 * client-supplied prompt content. That gap is pre-existing and tracked separately; do not read this
 * module as closing it.
 */

/**
 * An allowlist, not an open door. `session.systemPromptId` is client-settable - POST
 * /api/sessions/create spreads the request body through `createSessionParametersSchema`, which
 * accepts it - so a session must not be able to name an arbitrary admin/system prompt and have it
 * injected. Only ids meant to run as session-scoped modes belong here. `triage_router` is the
 * grounding-first request router.
 */
const SESSION_ACTIVATABLE_PROMPT_IDS = new Set<string>(['triage_router']);

/** Is this id one a session is permitted to activate? Unknown/empty ids are never activatable. */
export const isSessionActivatablePromptId = (promptId: string | undefined): boolean =>
  Boolean(promptId) && SESSION_ACTIVATABLE_PROMPT_IDS.has(promptId as string);

/**
 * Does this session carry its own authored prompt - raw text, or a registry prompt it is actually
 * allowed to activate?
 *
 * Every caller that suppresses a generic prompt because "the session has its own" must ask THIS,
 * not merely whether `systemPromptId` is set. A non-allowlisted id resolves to null when the
 * completion path tries to load it, so treating its mere presence as an authored prompt suppresses
 * the generic prompt and injects nothing in its place - leaving the session with neither.
 *
 * Whitespace-only `systemPromptText` does not count, matching how the completion path resolves it.
 *
 * LIMIT, because "leaving the session with neither" reads broader than what this closes: the check
 * is allowlist MEMBERSHIP, which is not the same question as "will resolve to content". An
 * allowlisted id whose registry record an admin has DISABLED still passes here (so the generic
 * prompt is suppressed) while the loader returns null (so nothing is injected) - the same
 * no-prompt-at-all outcome, reached a different way. A static predicate cannot see a runtime
 * disable; closing that would mean the route deciding suppression from the RESOLVED prompt rather
 * than from the id, which the route cannot do since resolution happens in the completion path.
 * Unreachable while no surface sets `systemPromptId`; revisit when one does.
 */
export const hasAuthoredSessionPrompt = (session: { systemPromptText?: string; systemPromptId?: string }): boolean =>
  Boolean(session.systemPromptText?.trim()) || isSessionActivatablePromptId(session.systemPromptId);
