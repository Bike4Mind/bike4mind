/**
 * PR report generator - the proofreading preview tokenizer.
 *
 * A SCOPED tokenizer, not a general mrkdwn parser: it recognizes exactly the four
 * constructs the renderer emits, so the preview cannot render something the digest
 * would never contain. It is coupled to the renderer on purpose - a new construct
 * there needs a matching case here, and both live in the same capability.
 *
 * Its whole job is letting an admin see WHO GETS PINGED before the send, because raw
 * Slack mention codes (`<@U…>`) are unreadable.
 */

import type { MarkupToken } from '@bike4mind/services';

/**
 * Ordered alternation. `<…>` forms are matched first because they are unambiguous;
 * emphasis is matched only inside the remaining text runs.
 *
 * Emphasis requires a boundary on BOTH sides - start/end of line, whitespace, or
 * bracketing punctuation. Without that, an identifier like `qa_passed` or a label like
 * `qa: in_progress` would falsely toggle italics and swallow half the line. The inner
 * group also forbids leading/trailing whitespace so `a * b * c` is not emphasis.
 */
const TOKEN_PATTERN = new RegExp(
  [
    // User mention: <@U01ABCDEF> (U/W only; a group renders via the subteam form below,
    // and a bare <@S...> is inert text in Slack, so it is deliberately NOT a mention).
    '<@(?<memberId>[UW][A-Z0-9]{6,})>',
    // Group mention: <!subteam^S01ABCDEF>
    '<!subteam\\^(?<subteam>S[A-Z0-9]{6,})>',
    // Link: <https://…|label>
    '<(?<url>[^|>\\s]+)\\|(?<label>[^>]*)>',
    // Bold: *text*
    '(?<=^|[\\s([{])\\*(?<bold>[^*\\s](?:[^*]*[^*\\s])?|[^*\\s])\\*(?=$|[\\s)\\]},.!?;:])',
    // Italic: _text_
    '(?<=^|[\\s([{])_(?<italic>[^_\\s](?:[^_]*[^_\\s])?|[^_\\s])_(?=$|[\\s)\\]},.!?;:])',
  ].join('|'),
  'g'
);

/**
 * Reverse the renderer's escaping for display. `&amp;` LAST, so a literal `&lt;` in a
 * PR title round-trips to `&lt;` rather than being decoded twice into `<`.
 */
function unescape(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function pushText(tokens: MarkupToken[], raw: string): void {
  if (!raw) return;
  tokens.push({ kind: 'text', text: unescape(raw) });
}

/**
 * Tokenize one line of the generated digest.
 *
 * @param line one line of `GenerateReportResponse.text`
 * @param mentionNames member id → display name, from the generate response. Resolved
 *   SERVER-SIDE: the Slack credential is bearer-equivalent and never reaches the
 *   browser, so there is deliberately no client-side lookup here. An id missing from
 *   the map renders as the raw id - a degraded but honest preview.
 */
export function tokenizeMarkupLine(line: string, mentionNames: Record<string, string>): MarkupToken[] {
  const tokens: MarkupToken[] = [];
  let lastIndex = 0;

  TOKEN_PATTERN.lastIndex = 0;
  for (let match = TOKEN_PATTERN.exec(line); match !== null; match = TOKEN_PATTERN.exec(line)) {
    pushText(tokens, line.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;

    const groups = match.groups ?? {};

    if (groups.memberId) {
      tokens.push({ kind: 'mention', name: mentionNames[groups.memberId] ?? groups.memberId });
    } else if (groups.subteam) {
      // A user-group ping. users.info cannot resolve a group id, so mentionNames rarely
      // carries a name here - the raw id is the honest fallback, exactly as for a user.
      tokens.push({ kind: 'mention', name: mentionNames[groups.subteam] ?? groups.subteam });
    } else if (groups.url !== undefined) {
      const url = unescape(groups.url);
      // Defense-in-depth: only http(s) becomes a live link. Server text never carries
      // another scheme, but this preview also renders admin-edited text, so a pasted
      // `<javascript:...|label>` must render as inert text rather than a clickable link.
      if (/^https?:\/\//i.test(url)) {
        tokens.push({ kind: 'link', url, label: unescape(groups.label ?? '') });
      } else {
        pushText(tokens, groups.label ?? '');
      }
    } else if (groups.bold !== undefined) {
      tokens.push({ kind: 'bold', text: unescape(groups.bold) });
    } else if (groups.italic !== undefined) {
      tokens.push({ kind: 'italic', text: unescape(groups.italic) });
    }
  }

  pushText(tokens, line.slice(lastIndex));
  return tokens;
}
