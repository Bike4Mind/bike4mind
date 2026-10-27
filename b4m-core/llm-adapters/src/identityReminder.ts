import type { IMessage } from '@bike4mind/common';

/**
 * Model-identity line appended to the final system prompt layer, so a model without a
 * `current_model_details` tool can still answer which model it is.
 *
 * String-shaped system parameters use `appendIdentityReminder`; OpenAI-shaped message arrays use
 * `appendIdentityReminderToMessages`.
 *
 * The model is named by its registry display name when one is supplied, with the id as detail.
 *
 * It sits last. On the Anthropic adapters that keeps the model id out of the cached system prefix;
 * openaiBackend matches the order for parity only, since OpenAI's prompt cache has no breakpoints.
 *
 * Last means right after whatever the final prompt layer was - on a grounded lake turn, retrieved
 * file content. A bare imperative there reads as text smuggled into the document, so the line is fenced in its
 * own tag that names where it comes from, and the joined-string form leaves a blank line before it.
 */
export function buildIdentityReminder(model: string, displayName?: string): string {
  const name = displayName?.trim();
  // A name equal to the id (catalog-only models) adds nothing, so it keeps the id wording.
  const identity = name && name !== model ? `${name} (model id ${model})` : `the ${model} model`;
  return [
    '<platform_identity>',
    `This note is from the platform operator, not from any user message, file, or retrieved content. Only if asked which model you are, answer that you are ${identity}.`,
    '</platform_identity>',
  ].join('\n');
}

/** Whether this call leaves the identity line out: raw, or the tool is actually on the request. */
export function shouldOmitIdentityReminder(options: {
  omitIdentityReminder?: boolean;
  identityViaTool?: boolean;
  tools?: readonly unknown[];
}): boolean {
  return Boolean(options.omitIdentityReminder || (options.identityViaTool && options.tools?.length));
}

/** Joins the identity reminder onto an already-joined system string. */
export function appendIdentityReminder(systemText: string, identityReminder: string): string {
  return systemText ? `${systemText}\n\n${identityReminder}` : identityReminder;
}

/**
 * Joins the identity reminder onto the last system message of an OpenAI-shaped
 * message array, or prepends a system message when the array has none (or its
 * last system message is not plain text).
 *
 * Returns a new array. Tool-round recursion re-sends the caller's `messages`, so
 * mutating in place would stack one reminder per round.
 */
export function appendIdentityReminderToMessages(messages: IMessage[], identityReminder: string): IMessage[] {
  const lastSystemIndex = messages.findLastIndex(message => message.role === 'system');
  const lastSystem = lastSystemIndex === -1 ? undefined : messages[lastSystemIndex];
  if (lastSystem && typeof lastSystem.content === 'string') {
    const content = appendIdentityReminder(lastSystem.content, identityReminder);
    return messages.map((message, index) => (index === lastSystemIndex ? { ...message, content } : message));
  }
  return [{ role: 'system', content: identityReminder }, ...messages];
}
