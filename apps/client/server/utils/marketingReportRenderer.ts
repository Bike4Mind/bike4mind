import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

// marked v15 passes raw HTML through; sanitize-html is the security boundary.
export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string;
}

export function sanitizeReportHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'p',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'ul',
      'ol',
      'li',
      'blockquote',
      'code',
      'pre',
      'a',
      'table',
      'thead',
      'tbody',
      'tr',
      'td',
      'th',
      'strong',
      'em',
      'hr',
      'br',
      'span',
      'div',
      'figure',
      'figcaption',
    ],
    allowedAttributes: {
      '*': ['class'],
      a: ['href', 'title'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: {
      a: ['http', 'https', 'mailto'],
    },
    disallowedTagsMode: 'discard',
  });
}

export function renderAndSanitize(md: string): string {
  return sanitizeReportHtml(renderMarkdown(md));
}
