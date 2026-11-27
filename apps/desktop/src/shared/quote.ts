/** `text` cut to `limit` characters, with a marker where it was cut. */
export function clipText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()} [...]`;
}

/** `text` as a markdown blockquote. */
export function blockquote(text: string): string {
  return text
    .split('\n')
    .map(line => `> ${line}`.trimEnd())
    .join('\n');
}
