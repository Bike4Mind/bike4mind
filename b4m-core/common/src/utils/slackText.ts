/**
 * Escaping for text interpolated into Slack mrkdwn. `<...>` delimits links and mentions, so a
 * value that is not server-authored must go through one of these before it lands in a message.
 *
 * `&` is replaced first so the entities added for `<`/`>` are not escaped twice. `*`, `_` and `~`
 * are left alone: Slack has no escape for them and replacing them would mangle identifiers.
 */
export function escapeSlackText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const LINE_TERMINATORS = /\r\n|[\r\n\t\v\f\u0085\u2028\u2029]/g;

/** For a value on a single labeled line, where a line break in it would start a new line. */
export function escapeSlackLine(value: string): string {
  return escapeSlackText(value).replace(LINE_TERMINATORS, ' ');
}

/** For a value inside a `code` span, where a backtick would close the span early. */
export function escapeSlackCode(value: string): string {
  return escapeSlackLine(value).replace(/`/g, '\u02CB');
}

// A zero-width space after the `@` keeps the word readable but stops Slack treating it as a mention.
const BROKEN_AT = '@​';
// `<!group>` is the legacy spelling of `<!channel>`.
const BROADCAST_SPECIAL_FORM = /<!(channel|here|everyone|group)(?:\|[^>]*)?>/gi;
// User-group mentions notify every member of the group, so they count as broadcasts too.
const USER_GROUP_FORM = /<!subteam\^[A-Za-z0-9]+(?:\|@?([^>]*))?>/gi;
const BARE_BROADCAST_WORD = /(^|[^A-Za-z0-9_])@(channel|here|everyone)\b/gi;

/**
 * Turns broadcast mentions (`<!channel>`, `<!here>`, `<!everyone>`, `<!group>`, user groups, and the bare
 * `@channel` / `@here` / `@everyone` words) into inert text. Unlike {@link escapeSlackText} it leaves
 * the rest of the markup alone, so links and `<@U123>` user mentions still work.
 */
export function neutralizeSlackBroadcastMentions(value: string): string {
  return value
    .replace(BROADCAST_SPECIAL_FORM, (_match, word: string) => `${BROKEN_AT}${word.toLowerCase()}`)
    .replace(USER_GROUP_FORM, (_match, label: string | undefined) => `${BROKEN_AT}${label || 'group'}`)
    .replace(BARE_BROADCAST_WORD, (_match, lead: string, word: string) => `${lead}${BROKEN_AT}${word}`);
}

/**
 * {@link neutralizeSlackBroadcastMentions} applied to every string inside a JSON value (Block Kit), plus
 * rich_text's structured mentions: a `broadcast` element (`range` channel/here/everyone) or a
 * `usergroup` element becomes a plain `text` element. `user` elements are kept. Recursive, so callers
 * must bound the depth first (findSlackApiPostBlocksProblem does for API posts).
 */
export function neutralizeSlackBroadcastMentionsDeep<T>(value: T): T {
  if (typeof value === 'string') return neutralizeSlackBroadcastMentions(value) as T;
  if (Array.isArray(value)) return value.map(item => neutralizeSlackBroadcastMentionsDeep(item)) as T;
  if (typeof value === 'object' && value !== null) {
    const element = value as Record<string, unknown>;
    if (element.type === 'broadcast') {
      const range = typeof element.range === 'string' ? element.range.replace(/[^a-z]/gi, '') : '';
      return { type: 'text', text: `${BROKEN_AT}${range || 'channel'}` } as T;
    }
    if (element.type === 'usergroup') return { type: 'text', text: `${BROKEN_AT}group` } as T;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, neutralizeSlackBroadcastMentionsDeep(child)])
    ) as T;
  }
  return value;
}
