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
