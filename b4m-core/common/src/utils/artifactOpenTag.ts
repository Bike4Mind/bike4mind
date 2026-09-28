// Linear-time readers for `<artifact ...>` markup. Each one reproduces a regex built from
// ARTIFACT_ATTRS_PATTERN (types/entities/ArtifactTypes.ts) match for match; that pattern
// backtracks quadratically when an attacker repeats an opener that never closes.

/**
 * How the whitespace after `<artifact` is read: `'one'` is `<artifact\s(attrs)>`, so the
 * capture keeps any further whitespace; `'run'` is `<artifact\s+(attrs)>`, which drops it all.
 */
export type ArtifactTagLeading = 'one' | 'run';

export interface ArtifactOpenTag {
  attrs: string;
  /** Index just past the tag's closing `>`. */
  end: number;
}

export interface ArtifactBlockMatch {
  index: number;
  fullMatch: string;
  attrs: string;
  body: string;
}

const OPENER_STICKY = /<artifact/iy;
const WHITESPACE = /\s/;
const CLOSER_LENGTH = '</artifact>'.length;

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && WHITESPACE.test(ch);
}

/** Per-text cache for scanArtifactOpenTag. Build one per text; never share it across texts. */
export interface ArtifactTagMemo {
  // ends[p] is 0 when unknown, else (index of the closing `>` or -1) + 2.
  ends?: Int32Array;
}

// Walks one step outside quotes: the next outside position, -1 for "no close", or -2 at `>`.
function step(text: string, p: number): number {
  const ch = text[p];
  if (ch === '>') return -2;
  if (ch === '"' || ch === "'") {
    const quoteEnd = text.indexOf(ch, p + 1);
    return quoteEnd < 0 ? -1 : quoteEnd + 1;
  }
  return p + 1;
}

// Index of the `>` ending a tag whose attributes start at `from`, or -1. The memo holds the
// answer for every outside-quote position a walk passes, so a restart at each later opener
// stops where an earlier walk already went, which keeps a scan of every opener linear.
// Without a memo it walks only to the close, so a lone call costs the tag, not the text.
function findTagClose(text: string, from: number, memo?: ArtifactTagMemo): number {
  if (!memo) {
    for (let p = from; p < text.length;) {
      const next = step(text, p);
      if (next === -2) return p;
      if (next === -1) return -1;
      p = next;
    }
    return -1;
  }
  const ends = (memo.ends ??= new Int32Array(text.length));
  let result = -1;
  for (let p = from; p < text.length;) {
    if (ends[p] !== 0) {
      result = ends[p] - 2;
      break;
    }
    const next = step(text, p);
    if (next === -2) {
      result = p;
      break;
    }
    if (next === -1) break;
    p = next;
  }
  for (let p = from; p < text.length && ends[p] === 0;) {
    ends[p] = result + 2;
    const next = step(text, p);
    if (next < 0) break;
    p = next;
  }
  return result;
}

/**
 * Reads an artifact open tag starting exactly at `at` (`<artifact` matched case-insensitively),
 * or returns null. When scanning several openers of one `text`, pass one `memo` to every call.
 */
export function scanArtifactOpenTag(
  text: string,
  at: number,
  leading: ArtifactTagLeading,
  memo?: ArtifactTagMemo
): ArtifactOpenTag | null {
  OPENER_STICKY.lastIndex = at;
  if (!OPENER_STICKY.test(text)) return null;
  let start = at + '<artifact'.length;
  if (!isSpace(text[start])) return null;
  start++;
  if (leading === 'run') {
    while (isSpace(text[start])) start++;
  }
  const close = findTagClose(text, start, memo);
  return close < 0 ? null : { attrs: text.slice(start, close), end: close + 1 };
}

function firstAtOrAfter(sorted: number[], min: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < min) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length ? sorted[lo] : -1;
}

/**
 * Every `<artifact ...>body</artifact>` block in `content`, identical to exec-looping
 * `/<artifact\s+(ATTRS)>([\s\S]*?)<\/artifact>/gi`: the body ends at the first closer after
 * the tag, and a failed opener retries one character later.
 */
export function matchArtifactBlocks(content: string): ArtifactBlockMatch[] {
  const blocks: ArtifactBlockMatch[] = [];
  const closers = Array.from(content.matchAll(/<\/artifact>/gi), m => m.index);
  const memo: ArtifactTagMemo = {};
  const opener = /<artifact/gi;
  for (let open = opener.exec(content); open; open = opener.exec(content)) {
    const tag = scanArtifactOpenTag(content, open.index, 'run', memo);
    const close = tag ? firstAtOrAfter(closers, tag.end) : -1;
    if (!tag || close < 0) {
      opener.lastIndex = open.index + 1;
      continue;
    }
    const end = close + CLOSER_LENGTH;
    blocks.push({
      index: open.index,
      fullMatch: content.slice(open.index, end),
      attrs: tag.attrs,
      body: content.slice(tag.end, close),
    });
    opener.lastIndex = end;
  }
  return blocks;
}
