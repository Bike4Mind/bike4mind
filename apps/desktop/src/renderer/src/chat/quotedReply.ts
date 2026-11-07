import { blockquote, clipText } from '@shared/quote';

/** The longest quote a reply carries; a longer highlight is cut with a marker. */
export const QUOTE_LIMIT = 4_000;

/** Must match the name pattern parseSkillInvocation in main/chat/skills/expand.ts accepts. */
const SKILL_INVOCATION = /^\/[A-Za-z0-9][A-Za-z0-9_:-]*(?:\s|$)/;

export function clampQuote(text: string): string {
  return clipText(text.trim(), QUOTE_LIMIT);
}

/**
 * The message a quoted reply sends: the quote as a markdown blockquote under "Regarding:", then
 * what the user typed. Plain text on purpose, so the stored turn, the model's copy, a refused
 * send handed back to the composer and an export all read the same.
 *
 * A skill runs only when the prompt starts with its slash, so for a skill invocation the quote
 * goes after it instead, where it arrives as part of the skill's arguments.
 */
export function quotedMessage(quote: string, message: string): string {
  const regarding = `Regarding:\n${blockquote(clampQuote(quote))}`;
  return SKILL_INVOCATION.test(message.trimStart())
    ? `${message.trimEnd()}\n\n${regarding}`
    : `${regarding}\n\n${message}`;
}
