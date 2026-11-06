/** The longest quote a reply carries; a longer highlight is cut with a marker. */
export const QUOTE_LIMIT = 4_000;

export function clampQuote(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= QUOTE_LIMIT ? trimmed : `${trimmed.slice(0, QUOTE_LIMIT).trimEnd()} [...]`;
}

/**
 * The message a quoted reply sends: the quote as a markdown blockquote under "Regarding:", then
 * what the user typed. Plain text on purpose, so the stored turn, the model's copy, a refused
 * send handed back to the composer and an export all read the same.
 */
export function quotedMessage(quote: string, message: string): string {
  const block = clampQuote(quote)
    .split('\n')
    .map(line => `> ${line}`.trimEnd())
    .join('\n');
  return `Regarding:\n${block}\n\n${message}`;
}
