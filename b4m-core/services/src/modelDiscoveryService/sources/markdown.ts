/**
 * Markdown reading shared by the docs scrapers (anthropicDocs, openaiDocs).
 *
 * Both providers publish their pricing and lifecycle pages as `.md` twins of the
 * rendered docs, and both express the facts we want as pipe tables under a
 * heading. This module owns that reading so a page-shape fix lands once.
 */

/**
 * A parser's result. Every parser here returns `{ ok: false }` when it finds
 * valid markdown and zero rows: "the page rendered and I found nothing" is the
 * shape of a parser that broke against a docs restructure, not of a provider that
 * retired or unpriced everything (sec 5.5), and an empty success would freeze or
 * clear a whole field group at once.
 */
export type ParseResult<T> = { ok: true; rows: T[] } | { ok: false; error: string };

export interface MarkdownTable {
  heading: string;
  headers: string[];
  rows: string[][];
}

export const cells = (line: string): string[] =>
  line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map(cell => cell.trim());

export const isSeparator = (line: string): boolean => /^\s*\|[\s:|-]+\|\s*$/.test(line);

/** Every pipe table in the document, tagged with the nearest preceding heading. */
export function tables(markdown: string): MarkdownTable[] {
  const lines = markdown.split(/\r?\n/);
  const found: MarkdownTable[] = [];
  let heading = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const headingMatch = /^#{1,6}\s+(.*)$/.exec(line);
    if (headingMatch) {
      heading = (headingMatch[1] ?? '').trim();
      continue;
    }
    if (!line.trimStart().startsWith('|') || !isSeparator(lines[index + 1] ?? '')) continue;

    const headers = cells(line);
    const rows: string[][] = [];
    index += 2;
    while (index < lines.length && (lines[index] ?? '').trimStart().startsWith('|')) {
      rows.push(cells(lines[index] ?? ''));
      index += 1;
    }
    index -= 1;
    found.push({ heading, headers, rows });
  }

  return found;
}

/** Strip inline links and code ticks, keeping the link text: docs pages are MDX. */
export const plain = (value: string): string =>
  value
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .trim();

/**
 * "$12.50 / MTok" and "$0.20" -> 12.5 and 0.2. Undefined for "N/A", "-" and
 * anything else carrying no figure, which is how both pages write "not published".
 */
export function parseRate(cell: string): number | undefined {
  const match = /\$\s*([\d,]+(?:\.\d+)?)/.exec(plain(cell));
  if (!match) return undefined;
  const value = Number(match[1]?.replace(/,/g, ''));
  return Number.isFinite(value) ? value : undefined;
}
