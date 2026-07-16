import { marked } from 'marked';
import DOMPurify from 'dompurify';
import Prism from 'prismjs';
// Side-effect import: registers the repo's Prism language grammars on the shared
// Prism singleton (HTML/JS/TS/python/bash/sql/...). This is the single source of
// truth for which languages highlight; the in-app code highlighter
// (CodeHighlightPlugin) imports the same module, so export and in-app rendering
// stay in sync.
import '@client/app/components/Session/prism-languages';

/**
 * Reusable markdown -> self-contained, styled HTML export.
 *
 * Consolidates the ad-hoc markdown->HTML conversion that used to live inline in
 * DownloadMenu into one utility so any feature wanting a styled HTML document
 * (session export, download menus, future report exports) shares the same
 * sanitization, syntax highlighting, print CSS, and branding.
 *
 * Security: marked v15 passes raw HTML through, so the markdown body is the
 * untrusted input. We DOMPurify-sanitize the rendered body (stripping scripts,
 * event handlers, and javascript: URIs) BEFORE wrapping it in the trusted
 * document shell + <style>, so sanitization never touches our own CSS. This
 * matches the repo convention that the sanitizer - not marked - is the security
 * boundary (see server/utils/marketingReportRenderer.ts and utils/htmlSanitizer.ts).
 *
 * Output modes:
 * - Single-file (implemented, the default): one self-contained .html with inline
 *   CSS and base64-inlined images, openable offline and printable to PDF in any
 *   browser. This is what the in-browser download consumers need.
 * - Multi-file (documented alternative, not built): emit the same HTML with
 *   images written as sibling asset files and referenced by relative path,
 *   for callers that prefer a folder over one large data-URI-heavy file. No
 *   current consumer downloads a folder, so only the single-file mode ships.
 */
export interface StyledHtmlOptions {
  /** <title> and branded header heading. */
  title?: string;
  /** Include the branded header/footer template. Default true. */
  branded?: boolean;
  /** Prepend a table of contents built from h1-h3. Default false. */
  includeToc?: boolean;
  /** Best-effort fetch + base64-inline of remote images. Default true. */
  inlineImages?: boolean;
}

const DEFAULT_TITLE = 'Export';

export async function renderMarkdownToStyledHtml(markdown: string, options: StyledHtmlOptions = {}): Promise<string> {
  const { title = DEFAULT_TITLE, branded = true, includeToc = false, inlineImages = true } = options;

  const bodyHtml = marked.parse(markdown ?? '', { gfm: true, breaks: true, async: false }) as string;

  // Post-process in a detached document so we can highlight, inline assets, and
  // build the ToC against real DOM before serializing back to a string.
  const doc = new DOMParser().parseFromString(`<body>${bodyHtml}</body>`, 'text/html');

  highlightCodeBlocks(doc);
  if (inlineImages) {
    await inlineRemoteImages(doc);
  }
  const tocHtml = includeToc ? buildTableOfContents(doc) : '';

  const safeBody = DOMPurify.sanitize(tocHtml + doc.body.innerHTML, {
    // data: image URIs (from inlining) and inline <svg> are allowed by
    // DOMPurify's defaults; we only extend it to keep links openable in a new
    // tab. Scripts/handlers are stripped by default - this output is opened
    // directly as a page, not in a sandbox, so scripts must never survive.
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'style'],
  });

  const header = branded ? renderHeader(title) : '';
  const footer = branded ? renderFooter() : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
${BASE_STYLESHEET}
${PRISM_STYLESHEET}
</style>
</head>
<body>
<main class="markdown-body">
${header}
${safeBody}
${footer}
</main>
</body>
</html>`;
}

/** Highlight fenced code blocks (`pre > code.language-*`) via Prism, in place. */
function highlightCodeBlocks(doc: Document): void {
  const blocks = doc.querySelectorAll('pre > code[class*="language-"]');
  blocks.forEach(code => {
    const languageClass = Array.from(code.classList).find(c => c.startsWith('language-'));
    const language = languageClass?.replace('language-', '') ?? '';
    const grammar = Prism.languages[language];
    // textContent is the unescaped source; Prism.highlight returns token markup.
    // Unknown languages have no grammar - leave the escaped plain text as-is.
    if (grammar && code.textContent) {
      code.innerHTML = Prism.highlight(code.textContent, grammar, language);
    }
  });
}

// Per-image fetch timeout (ms) so a hung/slow origin can't wedge the export.
const IMAGE_FETCH_TIMEOUT_MS = 10000;

/**
 * Fetch remote http(s) images and rewrite them to base64 data: URIs so the
 * output is self-contained. Best-effort: data: URIs are left untouched, and any
 * fetch/CORS failure (or the per-image timeout) keeps the original URL rather
 * than throwing.
 */
async function inlineRemoteImages(doc: Document): Promise<void> {
  const images = Array.from(doc.querySelectorAll('img'));
  await Promise.all(
    images.map(async img => {
      const src = img.getAttribute('src');
      if (!src || src.startsWith('data:')) return;
      if (!/^https?:\/\//i.test(src)) return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(src, { signal: controller.signal });
        if (!res.ok) return;
        const blob = await res.blob();
        const dataUri = await blobToDataUri(blob);
        img.setAttribute('src', dataUri);
      } catch {
        // Leave the original src; a broken image beats a failed export.
      } finally {
        clearTimeout(timer);
      }
    })
  );
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** Assign stable slug ids to h1-h3 and return a nav list linking to them. */
function buildTableOfContents(doc: Document): string {
  const headings = Array.from(doc.querySelectorAll('h1, h2, h3'));
  if (headings.length === 0) return '';

  // Track every assigned id (not just base slugs) so a disambiguated `foo-1`
  // can't collide with a heading whose text naturally slugifies to `foo-1`.
  const used = new Set<string>();
  const items = headings.map(h => {
    const text = h.textContent ?? '';
    const base = slugify(text);
    let slug = base;
    let i = 1;
    while (used.has(slug)) slug = `${base}-${i++}`;
    used.add(slug);
    h.setAttribute('id', slug);
    const level = h.tagName.toLowerCase();
    return `<li class="toc-${level}"><a href="#${slug}">${escapeHtml(text)}</a></li>`;
  });

  return `<nav class="toc"><p class="toc-title">Contents</p><ul>${items.join('')}</ul></nav>`;
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-') || 'section'
  );
}

function renderHeader(title: string): string {
  return `<header class="export-header"><h1 class="export-title">${escapeHtml(title)}</h1></header>`;
}

function renderFooter(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `<footer class="export-footer">Exported from Bike4Mind on ${date}</footer>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// GitHub-flavored base styling, adapted from the core FormatConverter
// (b4m-core notebookCurationService/formatConverter.ts) and extended with a
// branded header/footer, a table of contents, and print CSS.
const BASE_STYLESHEET = `
  :root { color-scheme: light; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 16px;
    line-height: 1.6;
    color: #24292e;
    background-color: #fff;
    margin: 0;
  }
  .markdown-body {
    box-sizing: border-box;
    max-width: 900px;
    margin: 0 auto;
    padding: 45px;
  }
  .export-header {
    border-bottom: 2px solid #0366d6;
    margin-bottom: 24px;
    padding-bottom: 12px;
  }
  .export-title { margin: 0; font-size: 1.6em; color: #0366d6; }
  .export-footer {
    margin-top: 32px;
    padding-top: 12px;
    border-top: 1px solid #eaecef;
    color: #6a737d;
    font-size: 0.85em;
  }
  .toc {
    border: 1px solid #eaecef;
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: 24px;
    background-color: #f6f8fa;
  }
  .toc-title { margin: 0 0 8px 0; font-weight: 600; }
  .toc ul { list-style: none; margin: 0; padding: 0; }
  .toc li { margin: 2px 0; }
  .toc-h2 { padding-left: 16px; }
  .toc-h3 { padding-left: 32px; }
  .toc a { color: #0366d6; text-decoration: none; }
  h1, h2, h3, h4, h5, h6 {
    margin-top: 24px;
    margin-bottom: 16px;
    font-weight: 600;
    line-height: 1.25;
  }
  h1 { font-size: 2em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
  h3 { font-size: 1.25em; }
  p { margin-bottom: 16px; }
  pre {
    background-color: #f6f8fa;
    border-radius: 6px;
    padding: 16px;
    overflow: auto;
    font-size: 85%;
    line-height: 1.45;
  }
  code {
    background-color: rgba(27,31,35,0.05);
    border-radius: 3px;
    padding: 0.2em 0.4em;
    font-family: 'SF Mono', Monaco, Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace;
    font-size: 85%;
  }
  pre code { background-color: transparent; padding: 0; font-size: 100%; }
  blockquote {
    padding: 0 1em;
    color: #6a737d;
    border-left: 0.25em solid #dfe2e5;
    margin: 0 0 16px 0;
  }
  ul, ol { margin-bottom: 16px; }
  table {
    border-collapse: collapse;
    width: 100%;
    margin-bottom: 16px;
    overflow: auto;
  }
  table th { font-weight: 600; background-color: #f6f8fa; }
  table th, table td { padding: 6px 13px; border: 1px solid #dfe2e5; }
  table tr:nth-child(2n) { background-color: #f6f8fa; }
  img { max-width: 100%; height: auto; }
  svg { max-width: 100%; }
  a { color: #0366d6; text-decoration: none; }
  a:hover { text-decoration: underline; }
  hr { height: 0.25em; margin: 24px 0; background-color: #e1e4e8; border: 0; }
  @page { margin: 1.6cm; }
  @media print {
    .markdown-body { max-width: none; padding: 0; }
    .export-header, .export-footer, .toc { break-inside: avoid; }
    pre, blockquote, table, img { break-inside: avoid; }
    a { color: #24292e; }
  }
`;

// Minimal Prism token palette (light) so highlighted code renders with color in
// the standalone document without pulling in an external Prism theme stylesheet.
const PRISM_STYLESHEET = `
  .token.comment, .token.prolog, .token.doctype, .token.cdata { color: #6a737d; }
  .token.punctuation { color: #24292e; }
  .token.property, .token.tag, .token.boolean, .token.number,
  .token.constant, .token.symbol, .token.deleted { color: #005cc5; }
  .token.selector, .token.attr-name, .token.string, .token.char,
  .token.builtin, .token.inserted { color: #032f62; }
  .token.operator, .token.entity, .token.url { color: #d73a49; }
  .token.atrule, .token.attr-value, .token.keyword { color: #d73a49; }
  .token.function, .token.class-name { color: #6f42c1; }
  .token.regex, .token.important, .token.variable { color: #e36209; }
`;
