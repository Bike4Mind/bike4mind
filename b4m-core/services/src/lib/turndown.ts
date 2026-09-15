import turndown from 'turndown';
// @ts-ignore There is no type definition for this package
import * as turndownPluginGfm from '@joplin/turndown-plugin-gfm';
import { capForParse } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { module: 'turndown' } });

// Scan budget for cleanEmailHtml. Sized from the measured cost AT the cap, not from
// headroom above a real email: with every cleaner below bounded the pass is linear,
// and the worst adversarial shape (an unterminated quoted attribute) measures ~120ms
// at 32k. A cap alone cannot bound these cleaners - unbounded, several are cubic and
// a 512k body ran for minutes - so the bounds and this number have to move together.
const EMAIL_HTML_PARSE_CAP = 32_000;

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

/**
 * Clean HTML by removing tracking pixels, signatures, and noise
 * Specifically designed for email content processing
 *
 * @param html - Raw HTML string
 * @returns Cleaned HTML string
 */
export function cleanEmailHtml(html: string): string {
  // The cap bounds what is SCANNED, not what is returned: the tail is re-appended
  // unchanged so an oversized email keeps all of its content. Truncating the return
  // value instead would silently drop the tail, and a cut landing inside a
  // <style>/<script> would strand its closing tag and leak CSS/JS through as text.
  // head + tail also reassembles the original exactly, so a cut between a surrogate
  // pair can't leave a lone surrogate in stored content.
  const head = capForParse(html, EMAIL_HTML_PARSE_CAP);
  const tail = html.slice(head.length);
  if (tail) {
    logger.warn('cleanEmailHtml: body over the parse cap, tail passed through uncleaned', {
      htmlLength: html.length,
      cap: EMAIL_HTML_PARSE_CAP,
    });
  }

  // Every span below is bounded on purpose. An unbounded `[^>]*` / `[^"']*` lets an
  // unterminated tag restart a full-document scan at every `<tag` position, which is
  // what made these cleaners quadratic-to-cubic; the element bodies additionally use
  // a tempered guard (`(?!<\/tag>)`) so a failed match stops at the next close tag
  // instead of running to the bound. The limits are far above any real email tag, so
  // matching is unchanged on well-formed input.
  let cleaned = head;

  // Remove WiseStamp tracking pixels
  cleaned = cleaned.replace(
    /<img[^>]{0,1000}src="https:\/\/tracy\.srv\.wisestamp\.com[^"]{0,1000}"[^>]{0,1000}>/gi,
    ''
  );
  cleaned = cleaned.replace(/<img[^>]{0,1000}alt="__tpx__"[^>]{0,1000}>/gi, '');

  // Remove generic tracking pixels (1x1 images)
  cleaned = cleaned.replace(/<img[^>]{0,1000}(?:width|height)=["']1["'][^>]{0,1000}>/gi, '');

  // Remove email signatures (various patterns)
  cleaned = cleaned.replace(
    /<!--\s*email signature\s*-->(?:(?!<!--\s*\/email signature\s*-->)[\s\S]){0,20000}?<!--\s*\/email signature\s*-->/gim,
    ''
  );
  cleaned = cleaned.replace(
    /<div[^>]{0,1000}class=["'][^"']{0,500}signature[^"']{0,500}["'][^>]{0,1000}>(?:(?!<\/div>)[\s\S]){0,20000}?<\/div>/gim,
    ''
  );
  cleaned = cleaned.replace(
    /<div[^>]{0,1000}gmail_signature[^>]{0,1000}>(?:(?!<\/div>)[\s\S]){0,20000}?<\/div>/gim,
    ''
  );

  // Remove unsubscribe links
  cleaned = cleaned.replace(
    /<a[^>]{0,1000}href=["'][^"']{0,500}unsubscribe[^"']{0,500}["'][^>]{0,1000}>(?:(?!<\/a>).){0,20000}?<\/a>/gi,
    ''
  );

  // Remove mailing list footers (Google Groups, etc.)
  cleaned = cleaned.replace(
    /<div[^>]{0,1000}class=["'][^"']{0,500}mailing-list[^"']{0,500}["'][^>]{0,1000}>(?:(?!<\/div>)[\s\S]){0,20000}?<\/div>/gim,
    ''
  );
  cleaned = cleaned.replace(/List-Unsubscribe:.*$/gim, '');

  // Remove social media icon tables (common in email signatures). The gap spans stop
  // at any table boundary, so this can no longer swallow an enclosing layout table
  // (which used to leave its orphaned `</td></tr></table>` behind) - a nested social
  // table is now matched on its own, which is the element actually being removed.
  cleaned = cleaned.replace(
    /<table[^>]{0,1000}>(?:(?!<\/?table)[\s\S]){0,4000}?<a[^>]{0,1000}(?:linkedin|twitter|facebook|instagram)[^>]{0,1000}>(?:(?!<\/?table)[\s\S]){0,2000}?<\/table>/gim,
    ''
  );

  // Remove excessive style/script tags
  cleaned = cleaned.replace(/<style[^>]{0,1000}>(?:(?!<\/style>)[\s\S]){0,20000}?<\/style>/gim, '');
  cleaned = cleaned.replace(/<script[^>]{0,1000}>(?:(?!<\/script>)[\s\S]){0,20000}?<\/script>/gim, '');

  return cleaned + tail;
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
