import turndown from 'turndown';
// @ts-ignore There is no type definition for this package
import * as turndownPluginGfm from '@joplin/turndown-plugin-gfm';

export const htmlToMarkdown = (html: string, _isArxiv: boolean = false) => {
  const turndownService = new turndown({
    headingStyle: 'atx',
    emDelimiter: '*',
    bulletListMarker: '-',
  });

  turndownService.addRule('headerAndFooters', {
    filter: ['header', 'footer'],
    replacement: function (content: string, node: Node) {
      return '';
    },
  });

  turndownService.addRule('scriptsAndStyles', {
    filter: ['script', 'style'],
    replacement: function (content: string, node: Node) {
      return '';
    },
  });

  // Enhance turndown with better code block handling
  turndownService.addRule('codeBlocks', {
    filter: ['pre', 'code'],
    replacement: function (content: string, node: Node) {
      const element = node as Element;
      const language = element.getAttribute('class') || '';
      const languageMatch = language.match(/language-(\w+)/);
      const languageStr = languageMatch ? languageMatch[1] : '';
      return '```' + languageStr + '\n' + content + '\n```\n';
    },
  });

  turndownService.addRule('listItems', {
    filter: 'li',
    replacement: function (content: string, node: Node) {
      const element = node as Element;
      const slot = element.getAttribute('slot');

      // Microsoft shadow-dom links
      if (!!slot) {
        const link = element.getAttribute('link');
        const ariaLabel = element.getAttribute('arialabel');
        return `* [${ariaLabel || content}](${link})\n`;
      }

      // Default list item handling
      const parent = element.parentNode as Element;
      const index = Array.prototype.indexOf.call(parent.children, element) + 1;
      const prefix = parent.nodeName.toLowerCase() === 'ol' ? `${index}. ` : '* ';
      return prefix + content + '\n';
    },
  });

  turndownService.use([turndownPluginGfm.tables, turndownPluginGfm.strikethrough]);

  const result = turndownService.turndown(html);

  return result;
};

/**
 * Extracts all links from a markdown string
 *
 * only URL links are extracted, not image links
 * @param markdown - The markdown string to extract links from
 * @returns An array of objects with the url and title of the link
 */
export const listMarkdownLinks = (
  markdown: string
): { url: string; fileType: string; isDownloadable: boolean }[] | null => {
  const links = markdown.match(/(?<!!)\[.*?\]\((.*?)\)/g);
  if (!links) {
    return null;
  }

  const commonFileTypes = ['pdf', 'xlsx', 'docx', 'pptx', 'zip', 'csv', 'xls'];

  return links.map(link => {
    const [, , urlWithTitle] = link.match(/(?<!!)\[(.*?)\]\((.*?)\)/) || [];
    const [url] = urlWithTitle.split(/\s+"/).map(s => s.replace(/"\s*$/, '').trim());

    // Extract file type only if the URL ends with a file extension
    const urlParts = url.split('/').pop()?.split('.');
    const fileType = urlParts && urlParts.length > 1 ? urlParts.pop()?.split('?')[0]?.toLowerCase() : undefined;
    const isDownloadable = !!fileType && commonFileTypes.includes(fileType);

    return { url, fileType: fileType || '', isDownloadable };
  });
};

// A tag span found by scanTags: `start`/`end` bracket the whole `<...>`. The source text
// is not carried on the tag - a large document has a lot of tags, and only the handful
// whose name a cleaner cares about ever need their attributes read.
type ScannedTag = { name: string; isClose: boolean; start: number; end: number };

const tagText = (html: string, tag: ScannedTag): string => html.slice(tag.start, tag.end);

/** `<br/>` closes itself, so it never opens an element. */
const isSelfClosing = (html: string, tag: ScannedTag): boolean => html[tag.end - 2] === '/';

const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);

/**
 * Offset just past the `>` that ends the tag whose attributes begin at `from`, or -1 when
 * the input ends first. Quote-aware, so a `>` inside an attribute value does not end it.
 */
function scanToTagEnd(html: string, from: number): number {
  let quote = '';
  for (let j = from; j < html.length; j++) {
    const c = html[j];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return j + 1;
    }
  }
  return -1;
}

/**
 * The close tag of the raw-text element whose body begins at `from`, or null when it never
 * closes.
 *
 * `</name` only closes the element when the next character ends the name - `>`, `/` or
 * whitespace - which is what the HTML spec requires. Accepting any character let a
 * `</scriptish` inside a JS string stand in for the real close, and the tag then ended at
 * the next `>` anywhere downstream. Both directions were wrong: the span could stop short
 * and leak the tail of a script body into the cleaned output, or run past the element and
 * delete real text after it. The search resumes one character past each near-miss, so the
 * cursor only moves forward and the walk stays linear.
 */
function findRawTextClose(
  html: string,
  lower: string,
  name: string,
  from: number
): { start: number; end: number } | null {
  let at = from;
  for (;;) {
    const close = lower.indexOf(`</${name}`, at);
    if (close === -1) return null;
    const afterName = close + name.length + 2;
    const next = html[afterName];
    if (next === '>' || next === '/' || (next !== undefined && /\s/.test(next))) {
      const end = scanToTagEnd(html, afterName);
      return end === -1 ? null : { start: close, end };
    }
    at = close + 1;
  }
}

/**
 * Tokenize every tag in the document in ONE left-to-right pass.
 *
 * This replaces the per-cleaner regexes that used to drive cleanEmailHtml. Each of those
 * restarted its own scan at every `<tag` position, which is what made the pass quadratic
 * to cubic; bounding the spans (`[^>]{0,1000}`, `(?:(?!</div>)[\s\S]){0,20000}?`) capped
 * the cost but at numbers below real email content - a signature div carrying an inline
 * base64 logo stopped being removed, and a long tracking URL pushed a 1x1 pixel out of
 * range. Bounds wide enough for real mail measured ~30s on 512k of adversarial markup, so
 * the bound could be correct or safe but not both. A single pass is neither: it is linear
 * in the document length with no span limits at all.
 *
 * Quoted attribute values are respected, so a `>` inside an attribute does not end a tag.
 * `<script>`/`<style>` bodies are taken as raw text to their own close tag, which is what
 * a real parser does and what keeps a `<` in CSS or JS from being read as markup.
 *
 * Malformed markup RECOVERS rather than ending the scan, so noise in the tail is still
 * found: an unterminated tag falls back to the first raw `>`, and a raw-text element that
 * never closes is closed at end of input. Only two things stop the walk early, and neither
 * leaves anything to clean behind it - a `<!--` with no `-->`, which extends to end of
 * input as comment text that the HTML parser downstream renders as nothing, and running
 * out of `>` entirely, after which no complete tag can exist.
 */
function scanTags(html: string): ScannedTag[] {
  const lower = html.toLowerCase();
  const tags: ScannedTag[] = [];
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;

    // Comments end at `-->`, not at the first `>`.
    if (lower.startsWith('<!--', lt)) {
      const close = lower.indexOf('-->', lt + 4);
      if (close === -1) break;
      i = close + 3;
      continue;
    }

    let j = lt + 1;
    const isClose = html[j] === '/';
    if (isClose) j++;
    const nameStart = j;
    while (j < html.length && /[a-z0-9:-]/i.test(html[j])) j++;
    const name = lower.slice(nameStart, j);
    if (!name) {
      i = lt + 1;
      continue;
    }

    let end = scanToTagEnd(html, j);
    if (end === -1) {
      // A quote opened inside this tag and never closed, so the quote-aware scan ran to
      // end of input. Recover at the first raw `>` the way a browser does rather than
      // abandoning the rest of the document: one stray `"` in an href would otherwise
      // leave every later tracking pixel and signature in place.
      const raw = html.indexOf('>', j);
      if (raw === -1) break;
      end = raw + 1;
    }
    tags.push({ name, isClose, start: lt, end });
    i = end;

    if (!isClose && RAW_TEXT_ELEMENTS.has(name) && html[end - 2] !== '/') {
      // An unterminated raw-text element runs to end of input, which is what the HTML
      // parser downstream does with it too, so close it there instead of stopping.
      const close = findRawTextClose(html, lower, name, end) ?? { start: html.length, end: html.length };
      tags.push({ name, isClose: true, start: close.start, end: close.end });
      i = close.end;
    }
  }

  return tags;
}

/**
 * For each tag index, the document offset just past its matching close tag (-1 when it
 * never closes, or for a close/void tag). Computed with one stack pass so a caller can
 * ask for any element's extent in O(1) - asking per element would be quadratic in the
 * tag count, which is the cost shape this rewrite exists to remove.
 *
 * Matching is per element NAME and last-in-first-out, so mis-nested markup
 * (`<div><span></div></span>`) pairs a close with the nearest open of its own name rather
 * than rejecting the document. That is the deliberate side of the trade: real mail is
 * mis-nested often enough that a strict matcher would stop removing signatures, and the
 * worst case here is an extent ending at the wrong close tag OF THE SAME NAME, never at
 * another element's.
 */
function matchElementEnds(html: string, tags: ScannedTag[]): number[] {
  const ends = new Array<number>(tags.length).fill(-1);
  const open = new Map<string, number[]>();
  for (let k = 0; k < tags.length; k++) {
    const tag = tags[k];
    if (tag.isClose) {
      const stack = open.get(tag.name);
      const from = stack?.pop();
      if (from !== undefined) ends[from] = tag.end;
    } else if (!isSelfClosing(html, tag)) {
      const stack = open.get(tag.name) ?? [];
      stack.push(k);
      open.set(tag.name, stack);
    }
  }
  return ends;
}

/** Cut `spans` out of `html`. Spans nested inside another span are dropped first. */
function spliceOut(html: string, spans: Array<[number, number]>): string {
  if (spans.length === 0) return html;
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span[0] < last[1]) {
      if (span[1] > last[1]) last[1] = span[1];
      continue;
    }
    merged.push([span[0], span[1]]);
  }
  let out = '';
  let cursor = 0;
  for (const [from, to] of merged) {
    out += html.slice(cursor, from);
    cursor = to;
  }
  return out + html.slice(cursor);
}

const SOCIAL_HOST_RE = /linkedin|twitter|facebook|instagram/i;

// Open tags whose whole element (open tag, body and close tag) is email noise.
const NOISE_ELEMENTS: Array<{ name: string; matches: (tag: string) => boolean }> = [
  { name: 'style', matches: () => true },
  { name: 'script', matches: () => true },
  { name: 'div', matches: tag => /class=["'][^"']*signature/i.test(tag) || /gmail_signature/i.test(tag) },
  { name: 'div', matches: tag => /class=["'][^"']*mailing-list/i.test(tag) },
  { name: 'a', matches: tag => /href=["'][^"']*unsubscribe/i.test(tag) },
];

// Standalone tags (no body) that are pure tracking noise.
const NOISE_TAGS: Array<{ name: string; matches: (tag: string) => boolean }> = [
  { name: 'img', matches: tag => /src=["']https:\/\/tracy\.srv\.wisestamp\.com/i.test(tag) },
  { name: 'img', matches: tag => /alt=["']__tpx__["']/i.test(tag) },
  { name: 'img', matches: tag => /(?:width|height)=["']1["']/i.test(tag) },
];

const EMAIL_SIGNATURE_OPEN_RE = /<!--\s*email signature\s*-->/gi;
const EMAIL_SIGNATURE_CLOSE_RE = /<!--\s*\/email signature\s*-->/gi;

/**
 * Clean HTML by removing tracking pixels, signatures, and noise
 * Specifically designed for email content processing
 *
 * Linear in the document length, and scans the whole document - there is no parse cap and
 * no span bound, so the contract holds for the entire input rather than a capped prefix.
 * The one construct that is not walked is the interior of an unterminated `<!--`: it is
 * comment text to end of input and renders as nothing downstream. See scanTags.
 *
 * @param html - Raw HTML string
 * @returns Cleaned HTML string
 */
export function cleanEmailHtml(html: string): string {
  const tags = scanTags(html);
  const elementEnds = matchElementEnds(html, tags);
  const spans: Array<[number, number]> = [];

  // Innermost enclosing <table> per tag, so a social icon link removes the table it is
  // actually in. Matching this with a regex could not: stopping the gap spans at any
  // table boundary (the previous fix for swallowing an enclosing layout table) also
  // stopped the cleaner firing on the standard signature shape, where a name/title
  // table closes BEFORE the icon row. A stack gets both, because it tracks nesting.
  const tableStack: number[] = [];

  for (let k = 0; k < tags.length; k++) {
    const tag = tags[k];

    if (tag.name === 'table') {
      if (tag.isClose) tableStack.pop();
    }

    if (!tag.isClose) {
      for (const noise of NOISE_ELEMENTS) {
        if (tag.name === noise.name && noise.matches(tagText(html, tag)) && elementEnds[k] > 0) {
          spans.push([tag.start, elementEnds[k]]);
        }
      }
      for (const noise of NOISE_TAGS) {
        if (tag.name === noise.name && noise.matches(tagText(html, tag))) {
          spans.push([tag.start, tag.end]);
        }
      }
      if (tag.name === 'a' && SOCIAL_HOST_RE.test(tagText(html, tag))) {
        const enclosing = tableStack[tableStack.length - 1];
        if (enclosing !== undefined && elementEnds[enclosing] > 0) {
          spans.push([tags[enclosing].start, elementEnds[enclosing]]);
        }
      }
    }

    if (tag.name === 'table' && !tag.isClose && !isSelfClosing(html, tag)) {
      tableStack.push(k);
    }
  }

  // `<!-- email signature -->...<!-- /email signature -->` is delimited by comments
  // rather than tags, so it is found on the source directly.
  EMAIL_SIGNATURE_OPEN_RE.lastIndex = 0;
  let signatureOpen: RegExpExecArray | null;
  while ((signatureOpen = EMAIL_SIGNATURE_OPEN_RE.exec(html)) !== null) {
    EMAIL_SIGNATURE_CLOSE_RE.lastIndex = signatureOpen.index + signatureOpen[0].length;
    const signatureClose = EMAIL_SIGNATURE_CLOSE_RE.exec(html);
    if (!signatureClose) break;
    spans.push([signatureOpen.index, signatureClose.index + signatureClose[0].length]);
    EMAIL_SIGNATURE_OPEN_RE.lastIndex = signatureClose.index + signatureClose[0].length;
  }

  // Line-anchored, so it needs no span bound to stay linear.
  return spliceOut(html, spans).replace(/List-Unsubscribe:.*$/gim, '');
}

/**
 * Convert HTML email content to clean Markdown
 * Uses cleanEmailHtml to remove noise before conversion
 *
 * @param html - HTML string (or plain text)
 * @returns Markdown string
 */
export function htmlToMarkdownForEmail(html: string | undefined | null): string {
  if (!html) return '';

  // Clean HTML before conversion
  const cleanHtml = cleanEmailHtml(html);

  // Convert to Markdown using existing htmlToMarkdown function
  const markdown = htmlToMarkdown(cleanHtml, false);

  // Post-process: remove excessive newlines
  return markdown
    .replace(/\n{4,}/g, '\n\n\n') // Max 2 blank lines
    .trim();
}

/**
 * Determine if email body content is substantial enough to warrant creating a fabFile
 *
 * @param bodyText - Plain text content
 * @param bodyHtml - HTML content
 * @param isNewsletter - Force creation for newsletters
 * @returns true if content is substantial
 */
export function isSubstantialEmailContent(
  bodyText: string | undefined,
  bodyHtml: string | undefined,
  isNewsletter: boolean = false
): boolean {
  // Always create fabFile for newsletters
  if (isNewsletter) {
    return true;
  }

  // Check plain text length
  if (bodyText && bodyText.length > 500) {
    return true;
  }

  // Check HTML length (more generous since HTML has tags)
  if (bodyHtml && bodyHtml.length > 2000) {
    return true;
  }

  return false;
}
