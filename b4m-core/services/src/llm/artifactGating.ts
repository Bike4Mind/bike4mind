/**
 * Whether artifacts are live for one chat completion: the deployment-wide admin setting AND the
 * caller's per-request flag. Within ChatCompletionProcess this gates BOTH the artifact-emission
 * system prompt and the post-stream extraction, so a turn is never told to emit artifacts that
 * nothing will extract, and never has artifacts spliced into a reply whose caller asked for none.
 *
 * Scope is the chat pipeline only. The agent-execution surface injects the same prompt off the
 * admin setting alone; its payload carries no per-request artifact flag, so there is no caller
 * intent for this to honour there.
 *
 * `undefined` means the caller expressed no preference and leaves the admin setting as the only
 * gate. That asymmetry is deliberate and load-bearing: most internal callers never set the flag,
 * and reading absence as "off" would silently strip artifacts from all of them. Only an explicit
 * `false` - the external /api/chat surface, the voice proxy, Slack - opts out. Clients that cannot
 * yet resolve the user's preference must therefore send nothing, not `false`.
 */
export function resolveArtifactsEnabled(adminEnabled: boolean, requestedByCaller: boolean | undefined): boolean {
  return adminEnabled && requestedByCaller !== false;
}
