/**
 * Which registry prompts a SESSION may activate, and whether a session carries its own authored
 * prompt at all.
 *
 * Lives in its own module rather than in `chatCompletionDefaults` for two reasons: this is an
 * authorization policy rather than a completion default, and `chatCompletionDefaults` reads SST
 * `Resource` bindings, so anything declared there cannot be unit-tested without a deploy context.
 * The allowlist is the only thing standing between a client-settable string and an injected
 * system prompt, so it needs to be testable.
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
 */
export const hasAuthoredSessionPrompt = (session: {
  systemPromptText?: string;
  systemPromptId?: string;
}): boolean => Boolean(session.systemPromptText?.trim()) || isSessionActivatablePromptId(session.systemPromptId);
