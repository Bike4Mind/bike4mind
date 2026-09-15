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

/**
 * Clean HTML by removing tracking pixels, signatures, and noise
 * Specifically designed for email content processing
 *
 * @param html - Raw HTML string
 * @returns Cleaned HTML string
 */
export function cleanEmailHtml(html: string): string {
  let cleaned = html;

  // Remove WiseStamp tracking pixels
  cleaned = cleaned.replace(/<img[^>]*src="https:\/\/tracy\.srv\.wisestamp\.com[^"]*"[^>]*>/gi, '');
  cleaned = cleaned.replace(/<img[^>]*alt="__tpx__"[^>]*>/gi, '');

  // Remove generic tracking pixels (1x1 images)
  cleaned = cleaned.replace(/<img[^>]*(?:width|height)=["']1["'][^>]*>/gi, '');

  // Remove email signatures (various patterns)
  cleaned = cleaned.replace(/<!--\s*email signature\s*-->[\s\S]*?<!--\s*\/email signature\s*-->/gim, '');
  cleaned = cleaned.replace(/<div[^>]*class=["'][^"']*signature[^"']*["'][^>]*>[\s\S]*?<\/div>/gim, '');
  cleaned = cleaned.replace(/<div[^>]*gmail_signature[^>]*>[\s\S]*?<\/div>/gim, '');

  // Remove unsubscribe links
  cleaned = cleaned.replace(/<a[^>]*href=["'][^"']*unsubscribe[^"']*["'][^>]*>.*?<\/a>/gi, '');

  // Remove mailing list footers (Google Groups, etc.)
  cleaned = cleaned.replace(/<div[^>]*class=["'][^"']*mailing-list[^"']*["'][^>]*>[\s\S]*?<\/div>/gim, '');
  cleaned = cleaned.replace(/List-Unsubscribe:.*$/gim, '');

  // Remove social media icon tables (common in email signatures)
  cleaned = cleaned.replace(
    /<table[^>]*>[\s\S]*?<a[^>]*(?:linkedin|twitter|facebook|instagram)[^>]*>[\s\S]*?<\/table>/gim,
    ''
  );

  // Remove excessive style/script tags
  cleaned = cleaned.replace(/<style[^>]*>[\s\S]*?<\/style>/gim, '');
  cleaned = cleaned.replace(/<script[^>]*>[\s\S]*?<\/script>/gim, '');

  return cleaned;
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
