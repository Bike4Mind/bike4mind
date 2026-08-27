/**
 * Which registry prompts a SESSION may activate.
 *
 * Whether a session will actually get an authored prompt injected (which the identity-suppression
 * decision depends on) is a RESOLUTION question, not a membership one - it lives in
 * `sessionSystemPromptResolver.ts` (`sessionWillInjectAuthoredPrompt`), because an allowlisted id an
 * admin has disabled resolves to nothing and membership alone cannot see that.
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
 *
 * ADDING A SECOND ID CHANGES THE BLAST RADIUS, so weigh it here. A data lake binds a preferred
 * prompt from this list, and the create-time binding is armed by lake READ access (which for a
 * public lake crosses orgs), while write access to set the binding is narrower (creator/admin). With
 * one benign id that is inert; with two, this set stops being "which modes a user may set on their
 * OWN session" and becomes "which prompts a lake owner may impose on other orgs' users." A new id
 * should be safe to run for any reader of any lake, or the lake-binding surface needs its own gate.
 */
const SESSION_ACTIVATABLE_PROMPT_IDS = new Set<string>(['triage_router']);

/** Is this id one a session is permitted to activate? Unknown/empty ids are never activatable. */
export const isSessionActivatablePromptId = (promptId: string | undefined): boolean =>
  Boolean(promptId) && SESSION_ACTIVATABLE_PROMPT_IDS.has(promptId as string);
