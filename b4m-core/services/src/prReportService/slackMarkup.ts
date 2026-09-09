/**
 * PR report generator - Slack mrkdwn assembly.
 *
 * Escaping here is a correctness/injection property, not a nicety. PR titles and
 * author logins are attacker-influenced text that lands in a message where `<…>`
 * delimits mentions and links, so an unescaped title could inject a mention that
 * pings the channel or a link that points anywhere.
 */

/**
 * Escape the characters Slack reserves in message text.
 *
 * `&` must be replaced first, otherwise the `&` introduced by the `<`/`>`
 * replacements would be double-escaped into `&amp;lt;`.
 *
 * `*` and `_` are deliberately NOT escaped: Slack has no backslash escape for
 * them, and mangling them would corrupt ordinary identifiers like
 * `qa_passed`. Emphasis is instead kept unambiguous on the read side - the preview
 * tokenizer requires whitespace/edge boundaries, so a `_` inside an identifier
 * cannot falsely toggle italics.
 */
export function escapeSlackText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A mention that actually notifies. `memberId` must be a real Slack member id.
 *
 * The id prefix is the discriminator (see MEMBER_ID_PATTERN in identityLookup): `U`/`W`
 * are users, `S` is a user group. Slack notifies a group ONLY through the subteam form -
 * `<@S...>` renders as inert text and pings nobody, which would silently defeat the
 * whole role-roster gate. Ids are normalized upper-case by the parser, so a bare `S`
 * check is sufficient.
 */
export function slackMention(memberId: string): string {
  if (memberId.startsWith('S')) return `<!subteam^${memberId}>`;
  return `<@${memberId}>`;
}

/**
 * A link with a display label. The label is escaped; the URL is escaped too, since
 * an unescaped `>` in it would terminate the link early and spill raw markup.
 */
export function slackLink(url: string, label: string): string {
  return `<${escapeSlackText(url)}|${escapeSlackText(label)}>`;
}

export function slackBold(value: string): string {
  return `*${value}*`;
}

export function slackItalic(value: string): string {
  return `_${value}_`;
}
