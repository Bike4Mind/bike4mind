import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderMarkdownToStyledHtml } from '../markdownToStyledHtml';

describe('renderMarkdownToStyledHtml', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('produces a complete, self-contained HTML document with inline styles', async () => {
    const html = await renderMarkdownToStyledHtml('# Hello\n\nSome **bold** text.');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<style>');
    expect(html).toContain('class="markdown-body"');
    expect(html).toContain('<h1');
    expect(html).toContain('Hello');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('strips scripts and event handlers from the rendered body', async () => {
    const html = await renderMarkdownToStyledHtml(
      'Text\n\n<script>alert(1)</script>\n\n<img src="x" onerror="alert(2)">'
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('onerror');
  });

  it('syntax-highlights fenced code blocks with a known language', async () => {
    const md = '```js\nconst x = 1;\n```';
    const html = await renderMarkdownToStyledHtml(md);
    expect(html).toContain('language-js');
    expect(html).toContain('class="token');
  });

  it('leaves an unknown code language as plain (escaped) text', async () => {
    const md = '```notalang\nplain text\n```';
    const html = await renderMarkdownToStyledHtml(md);
    expect(html).toContain('plain text');
    expect(html).toContain('language-notalang');
  });

  it('passes data: image URIs through untouched', async () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
    const html = await renderMarkdownToStyledHtml(`![pic](${dataUri})`);
    expect(html).toContain(dataUri);
  });

  it('inlines remote images as base64 when inlineImages is on', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob([bytes], { type: 'image/png' }),
      }))
    );
    const html = await renderMarkdownToStyledHtml('![pic](https://example.com/a.png)', { inlineImages: true });
    expect(html).toContain('data:image/png;base64,');
    expect(html).not.toContain('https://example.com/a.png');
  });

  it('keeps the original src when remote image inlining fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('CORS');
      })
    );
    const html = await renderMarkdownToStyledHtml('![pic](https://example.com/a.png)', { inlineImages: true });
    expect(html).toContain('https://example.com/a.png');
  });

  it('does not fetch remote images when inlineImages is off', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const html = await renderMarkdownToStyledHtml('![pic](https://example.com/a.png)', { inlineImages: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(html).toContain('https://example.com/a.png');
  });

  it('gives every heading a unique TOC anchor even when slugs would collide', async () => {
    const md = '# Foo\n\n## Foo\n\n### Foo-1';
    const html = await renderMarkdownToStyledHtml(md, { includeToc: true });
    const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map(m => m[1]);
    expect(new Set(anchors).size).toBe(anchors.length);
    expect(anchors).toContain('foo');
  });

  it('adds a table of contents only when includeToc is set', async () => {
    const md = '# First\n\ntext\n\n## Second\n\nmore';
    const withToc = await renderMarkdownToStyledHtml(md, { includeToc: true });
    expect(withToc).toContain('class="toc"');
    expect(withToc).toContain('href="#first"');
    expect(withToc).toContain('href="#second"');

    const withoutToc = await renderMarkdownToStyledHtml(md);
    expect(withoutToc).not.toContain('class="toc"');
  });

  it('includes the branded header/footer by default and omits it when branded is false', async () => {
    const branded = await renderMarkdownToStyledHtml('# Doc', { title: 'My Report' });
    expect(branded).toContain('class="export-header"');
    expect(branded).toContain('My Report');
    expect(branded).toContain('Exported from Bike4Mind');

    const plain = await renderMarkdownToStyledHtml('# Doc', { title: 'My Report', branded: false });
    expect(plain).not.toContain('class="export-header"');
    expect(plain).not.toContain('class="export-footer"');
  });

  it('uses the title in the document <title> and escapes it', async () => {
    const html = await renderMarkdownToStyledHtml('text', { title: 'A & B <c>' });
    expect(html).toContain('<title>A &amp; B &lt;c&gt;</title>');
  });

  it('handles empty input without throwing', async () => {
    const html = await renderMarkdownToStyledHtml('');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
  });
});
