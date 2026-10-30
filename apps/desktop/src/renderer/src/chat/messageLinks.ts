import { isExternallyOpenable } from '@shared/externalLinks';

export type TextSegment = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string };

/**
 * A run that starts with a scheme we would open. Quotes, angle brackets and backticks end it,
 * because none of them can appear raw in a url and all of them commonly wrap one in prose.
 */
const URL_CANDIDATE = /\b(?:https?:\/\/|mailto:)[^\s<>"`]+/gi;

/** Sentence punctuation that follows a url far more often than it ends one (GFM's own list, plus quotes). */
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', "'", '*', '_', '~', '\u2019', '\u201d']);

const OPENER_OF: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function occurrences(text: string, character: string): number {
  return text.split(character).length - 1;
}

/**
 * Drops what a writer put after the url rather than in it: `see https://x.com/a.` ends at `a`,
 * `(https://x.com/a)` loses the `)`, while `https://en.wikipedia.org/wiki/Foo_(bar)` keeps its
 * balanced pair.
 */
function trimTrailing(candidate: string): string {
  let url = candidate;
  for (;;) {
    const last = url.at(-1);
    if (last === undefined) return url;
    const opener = OPENER_OF[last];
    const strayCloser = opener !== undefined && occurrences(url, last) > occurrences(url, opener);
    if (!TRAILING_PUNCTUATION.has(last) && !strayCloser) return url;
    url = url.slice(0, -1);
  }
}

/** Openable, and naming something: a bare `https://` or `mailto:` is a word, not a link. */
function isLinkable(url: string): boolean {
  if (!isExternallyOpenable(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === 'mailto:' ? parsed.pathname.length > 0 : parsed.hostname.length > 0;
}

/**
 * Plain text cut into the runs to print and the urls to link, in order and losing nothing:
 * joining every segment's `text` gives back the input exactly.
 *
 * Only http(s) and mailto are ever linked, which is the same allowlist main enforces when the
 * link is followed - so nothing is drawn as a link that would then refuse to open.
 */
export function splitLinks(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_CANDIDATE)) {
    const url = trimTrailing(match[0]);
    if (!isLinkable(url)) continue;
    if (match.index > cursor) segments.push({ kind: 'text', text: text.slice(cursor, match.index) });
    segments.push({ kind: 'link', text: url, href: url });
    cursor = match.index + url.length;
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
  return segments;
}
