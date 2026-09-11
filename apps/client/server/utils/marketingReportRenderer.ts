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
      'img',
    ],
    allowedAttributes: {
      '*': ['class'],
      a: ['href', 'title'],
      // Markdown-embedded images (`![](...)`) in what's-new emails; the hero image is
      // concatenated raw upstream, so without this only markdown images were silently dropped.
      img: ['src', 'alt', 'width', 'height'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: {
      a: ['http', 'https', 'mailto'],
      // No data: / javascript: image srcs - only remotely hosted images, matching the hero image.
      img: ['http', 'https'],
    },
    disallowedTagsMode: 'discard',
  });
}

export function renderAndSanitize(md: string): string {
  return sanitizeReportHtml(renderMarkdown(md));
}
