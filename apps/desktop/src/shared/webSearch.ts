/**
 * The web tools' names and the one parser both sides read a search result with: main to count
 * hits for the model's header, the renderer to list them under the row.
 *
 * The text is what /api/tools/web-search returns (performWebSearch in
 * b4m-core/services/src/llm/tools/implementation/websearch): one block per hit, separated by a
 * blank line, that opens with `N. **title**` and closes with `Source: [host](url)`. Must stay in
 * sync with that format.
 */

export const WEB_SEARCH_TOOL_NAME = 'web_search';
export const WEB_FETCH_TOOL_NAME = 'web_fetch';

export interface WebSearchHit {
  title: string;
  url: string;
  host: string;
}

/** web_search returns at most 10; anything past this is not a list the row should draw. */
const MAX_HITS = 20;

const TITLE_LINE = /^\d+\. \*\*(.*)\*\*$/;
const SOURCE_LINE = /^Source: \[[^\]\n]*\]\((\S+)\)$/;

export function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function hostOf(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * The hits in a search result, in order.
 *
 * Read per block, first line and last line only: the server strips newlines from titles and
 * snippets, so a hostile snippet cannot start a block of its own, and a snippet written to look
 * like a `Source:` line is never the block's last line.
 */
export function parseWebSearchResults(text: string): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;
    const title = TITLE_LINE.exec(lines[0])?.[1]?.trim();
    const url = SOURCE_LINE.exec(lines[lines.length - 1])?.[1];
    if (!title || !url || !isWebUrl(url)) continue;
    hits.push({ title, url, host: hostOf(url) });
    if (hits.length === MAX_HITS) break;
  }
  return hits;
}
