export const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * Parses JSON that is not strictly valid but is common in the wild: a leading UTF-8 BOM, `//` and
 * `/* *\/` comments, and trailing commas before `}` or `]`. Strict input parses identically to
 * `JSON.parse`. Throws the strict parser's SyntaxError when the cleaned text still is not JSON, so
 * its position refers to the input minus any leading BOM, not to the comment-stripped text.
 *
 * Sibling: `parseToolArgsLenient` in b4m-core/agents/src/ReActAgent.ts repairs LLM tool-call JSON.
 * It is kept separate: a different input boundary (model output vs uploaded file bytes) and a
 * different repair set (code fences vs BOM and comments).
 */
export function parseLenientJson(text: string): unknown {
  const source = stripBom(text);
  try {
    return JSON.parse(source);
  } catch (strictError) {
    const cleaned = stripCommentsAndTrailingCommas(source);
    if (cleaned === source) throw strictError;
    try {
      return JSON.parse(cleaned);
    } catch {
      throw strictError;
    }
  }
}

// Index just past the comment starting at `i`, or `i` when none starts there. A line comment stops
// before its line break (JSON.parse treats a lone CR as whitespace too). `lastClose` is the
// precomputed `source.lastIndexOf('*/')`, so an unterminated `/*` costs O(1) instead of a rescan.
function skipComment(source: string, i: number, lastClose: number): number {
  if (source[i] !== '/') return i;
  if (source[i + 1] === '/') {
    let end = i;
    while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end++;
    return end;
  }
  if (source[i + 1] === '*') {
    // Unterminated: not a comment, so the stray `/*` keeps the text invalid instead of silently
    // dropping everything after it.
    return lastClose < i + 2 ? i : source.indexOf('*/', i + 2) + 2;
  }
  return i;
}

// Scans once, tracking string state so `//`, `/*` and `,]` inside a string value are left alone.
function stripCommentsAndTrailingCommas(source: string): string {
  let out = '';
  let lastSignificant = '';
  const lastClose = source.lastIndexOf('*/');
  let i = 0;
  while (i < source.length) {
    const ch = source[i];

    if (ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      lastSignificant = '"';
      i = j + 1;
    } else if (skipComment(source, i, lastClose) !== i) {
      // A space, not nothing: `1/**/2` must not fuse into `12`.
      out += ' ';
      i = skipComment(source, i, lastClose);
    } else if (ch === ',') {
      const next = nextSignificantChar(source, i + 1, lastClose);
      // Only a comma after a real member is trailing; `{,}` and `[1,,]` stay invalid.
      const trailing = (next === '}' || next === ']') && lastSignificant && !'{[,'.includes(lastSignificant);
      if (!trailing) {
        out += ch;
        lastSignificant = ch;
      }
      i++;
    } else {
      out += ch;
      if (!/\s/.test(ch)) lastSignificant = ch;
      i++;
    }
  }
  return out;
}

// First character at or after `from` that is not whitespace or inside a comment.
function nextSignificantChar(source: string, from: number, lastClose: number): string | undefined {
  let i = from;
  while (i < source.length) {
    const afterComment = skipComment(source, i, lastClose);
    if (afterComment !== i) i = afterComment;
    else if (/\s/.test(source[i])) i++;
    else return source[i];
  }
  return undefined;
}
