import { extractHTMLTitle } from '@bike4mind/utils/artifactParser';

/** The trimmed <title> of an HTML error page, or null when it has none or it is just "Error". */
export function htmlErrorTitle(html: string): string | null {
  const title = extractHTMLTitle(html);
  return title !== null && title !== 'Error' ? title.trim() : null;
}

const LINE_TERMINATOR = /[\n\r\u2028\u2029]/g;

function nextIndex(re: RegExp, text: string, from: number): number {
  re.lastIndex = from;
  const m = re.exec(text);
  return m === null ? -1 : m.index;
}

/** Same result as html.match(/<h1>(.*?)<\/h1>/i)?.[1] ?? null, in linear time. */
export function htmlFirstH1(html: string): string | null {
  const opener = /<h1>/gi;
  const closer = /<\/h1>/gi;
  let closeAt = -2;
  let lineEndAt = -2;
  for (let s = nextIndex(opener, html, 0); s !== -1; s = nextIndex(opener, html, s + 1)) {
    const start = s + 4;
    if (closeAt !== -1 && closeAt < start) closeAt = nextIndex(closer, html, start);
    if (closeAt === -1) return null;
    if (lineEndAt !== -1 && lineEndAt < start) lineEndAt = nextIndex(LINE_TERMINATOR, html, start);
    if (lineEndAt === -1 || closeAt < lineEndAt) return html.slice(start, closeAt);
  }
  return null;
}

/** Same result as html.match(/<body[^>]*>(.*?)<\/body>/is)?.[1] ?? null, in linear time. */
export function htmlBodyInner(html: string): string | null {
  // Only the first opener can match: a later one shares or passes its tag end and closer.
  const s = nextIndex(/<body/gi, html, 0);
  if (s === -1) return null;
  const tagEnd = html.indexOf('>', s + 5);
  if (tagEnd === -1) return null;
  const closeAt = nextIndex(/<\/body>/gi, html, tagEnd + 1);
  return closeAt === -1 ? null : html.slice(tagEnd + 1, closeAt);
}

/** Same result as text.replace(/<[^>]+>/g, ' '), in linear time. */
export function replaceHtmlTags(text: string): string {
  let out = '';
  let copiedTo = 0;
  let i = text.indexOf('<');
  while (i !== -1) {
    const gt = text.indexOf('>', i + 1);
    if (gt === -1) break;
    if (gt > i + 1) {
      out += text.slice(copiedTo, i) + ' ';
      copiedTo = gt + 1;
      i = text.indexOf('<', gt + 1);
    } else {
      i = text.indexOf('<', i + 1);
    }
  }
  return out + text.slice(copiedTo);
}
