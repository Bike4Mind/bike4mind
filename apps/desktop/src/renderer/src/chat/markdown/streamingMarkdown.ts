/** Up to three spaces of indent, then the fence itself, then whatever the line carries after it. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The same text with an unterminated code fence closed off.
 *
 * Every delta hands the renderer a half-written message, so while a code block streams its
 * fence is open by definition. remark already runs an unclosed fence to the end of the input,
 * which draws the right thing on its own - with one exception that this exists for: when the
 * opening fence is the last line and nothing has arrived under it yet, the code node starts
 * and ends on that single line, and the position test ReplyMarkdown uses to tell inline code
 * from a block reads any single-line node as inline. The block would render as an inline chip
 * for one token and then jump into a block once the next newline landed. Closing the fence
 * keeps the node two lines tall from the moment it opens, so it is a block the whole way.
 *
 * Nothing else about a half-written message is repaired here. A table whose delimiter row has
 * not arrived is a paragraph, and a "**" with no partner is those two characters, because that
 * is what the text says so far; both settle as the rest lands. Guessing at the author's
 * intention would mean drawing something the model has not said yet.
 */
export function closeOpenFence(text: string): string {
  let open: string | null = null;

  for (const line of text.split('\n')) {
    const match = FENCE_LINE.exec(line);
    if (!match) continue;
    const [, marker, rest] = match;

    if (open === null) {
      // An info string may not contain a backtick, which is what stops "```a`b" opening a block.
      if (marker.startsWith('`') && rest.includes('`')) continue;
      open = marker;
      continue;
    }

    // A closing fence is the same character, at least as long, and carries nothing else.
    if (marker[0] === open[0] && marker.length >= open.length && rest.trim() === '') open = null;
  }

  if (open === null) return text;
  return text.endsWith('\n') ? `${text}${open}` : `${text}\n${open}`;
}
