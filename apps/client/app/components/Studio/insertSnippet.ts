/**
 * `value` with `snippet` replacing `[start, end)` on a line of its own. The caret goes to the start of the line after
 * it, where the section's text is typed.
 */
export function insertSnippet(
  value: string,
  snippet: string,
  start: number,
  end: number
): { value: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before.length === 0 || before.endsWith('\n') ? '' : '\n';
  const trail = after.startsWith('\n') ? '' : '\n';
  const inserted = `${lead}${snippet}${trail}`;
  return { value: `${before}${inserted}${after}`, caret: before.length + lead.length + snippet.length + 1 };
}
