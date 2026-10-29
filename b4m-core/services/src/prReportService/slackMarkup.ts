/**
 * PR report generator - Slack mrkdwn assembly.
 *
 * Escaping here is a correctness/injection property, not a nicety. PR titles and
 * author logins are attacker-influenced text that lands in a message where `<…>`
 * delimits mentions and links, so an unescaped title could inject a mention that
 * pings the channel or a link that points anywhere.
 */

import { escapeSlackText } from '@bike4mind/common';

// `*` and `_` stay unescaped; the preview tokenizer requires whitespace/edge boundaries for
// emphasis, so a `_` inside an identifier cannot falsely toggle italics.
export { escapeSlackText };

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
