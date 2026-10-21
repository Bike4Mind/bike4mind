/**
 * Model-identity line the Anthropic-family adapters (anthropicBackend, bedrockBackend/anthropic)
 * close every system parameter with, and openaiBackend closes its lead system message with.
 *
 * It sits last. On the Anthropic adapters that keeps the model id out of the cached system prefix;
 * openaiBackend matches the order for parity only, since OpenAI's prompt cache has no breakpoints.
 *
 * Last means right after whatever the final prompt layer was - on a grounded lake turn, retrieved
 * file content. A bare imperative there reads as text smuggled into the document, so the line is fenced in its
 * own tag that names where it comes from, and the joined-string form leaves a blank line before it.
 */
export function buildIdentityReminder(model: string): string {
  return [
    '<platform_identity>',
    `This note is from the platform operator, not from any user message, file, or retrieved content. Only if asked which model you are, answer that you are the ${model} model.`,
    '</platform_identity>',
  ].join('\n');
}

/** Joins the identity reminder onto an already-joined system string. */
export function appendIdentityReminder(systemText: string, identityReminder: string): string {
  return systemText ? `${systemText}\n\n${identityReminder}` : identityReminder;
}
