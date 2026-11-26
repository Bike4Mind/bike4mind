import { closeTruncatedMarkdown, truncateMarkdown } from './markdown';

/** Zod `.max()` counts UTF-16 units while the text limits count code points; a body must satisfy both. */
export function truncateToSchemaCap(source: string, max: number): { text: string; truncated: boolean } {
  const byPoints = truncateMarkdown(source, max);
  if (byPoints.text.length <= max) return byPoints;
  let cut = '';
  for (const ch of source) {
    if (cut.length + ch.length > max - 1) break;
    cut += ch;
  }
  return { text: closeTruncatedMarkdown(cut), truncated: true };
}
