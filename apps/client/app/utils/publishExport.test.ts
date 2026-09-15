import { describe, it, expect } from 'vitest';
import {
  EXPORT_CONTENT_TYPE,
  buildExportActionsHtml,
  buildMarkdownExport,
  exportFilename,
  exportFormatsFor,
  exportHref,
  parseExportFormat,
  supportsExport,
} from './publishExport';

describe('exportFormatsFor', () => {
  it('offers Markdown only for replies, whose stored body IS markdown', () => {
    expect(exportFormatsFor('reply')).toEqual(['md', 'html']);
    expect(exportFormatsFor('bundle')).toEqual(['html']);
    expect(exportFormatsFor('fabfile')).toEqual(['html']);
  });

  it('never withholds HTML - every kind has a faithful HTML form', () => {
    for (const kind of ['bundle', 'reply', 'fabfile'] as const) {
      expect(supportsExport(kind, 'html')).toBe(true);
    }
  });

  it('withholds Markdown for bundles rather than emitting a lossy conversion', () => {
    expect(supportsExport('bundle', 'md')).toBe(false);
    expect(supportsExport('fabfile', 'md')).toBe(false);
  });
});

describe('parseExportFormat', () => {
  it('accepts only the supported formats', () => {
    expect(parseExportFormat('md')).toBe('md');
    expect(parseExportFormat('html')).toBe('html');
  });

  it('rejects anything else, including a repeated query param', () => {
    for (const raw of ['pdf', '', 'MD', undefined, null, 1, ['md', 'html']]) {
      expect(parseExportFormat(raw)).toBeNull();
    }
  });
});

describe('exportFilename', () => {
  it('slugifies the title and appends the extension', () => {
    expect(exportFilename('My Great Artifact', 'md')).toBe('my-great-artifact.md');
    expect(exportFilename('My Great Artifact', 'html')).toBe('my-great-artifact.html');
  });

  it('falls back to a neutral stem when the title slugifies to nothing', () => {
    expect(exportFilename('???', 'md')).toBe('artifact.md');
    expect(exportFilename('', 'html')).toBe('artifact.html');
  });

  it('stays quote-free and ASCII so it needs no Content-Disposition escaping', () => {
    // Escapes, not literals - this file stays ASCII (see CLAUDE.md).
    const name = exportFilename('He said "hi" \u2014 na\u00EFve/\u00FCnicode', 'html');
    expect(name).toBe('he-said-hi-na-ve-nicode.html');
    expect(name).toMatch(/^[a-z0-9.-]+$/);
  });

  it('bounds the stem length', () => {
    expect(exportFilename('a'.repeat(200), 'md')).toBe(`${'a'.repeat(60)}.md`);
  });
});

describe('buildMarkdownExport', () => {
  it('leads with the title, then the description, then the body verbatim', () => {
    expect(buildMarkdownExport('Title', 'A description', '## Body\n\ntext')).toBe(
      '# Title\n\nA description\n\n## Body\n\ntext\n'
    );
  });

  it('omits an absent or blank description and an empty body', () => {
    expect(buildMarkdownExport('Title', undefined, '')).toBe('# Title\n');
    expect(buildMarkdownExport('Title', '   ', 'body')).toBe('# Title\n\nbody\n');
  });

  it('does not escape or reflow the body - markdown must round-trip', () => {
    const body = '- item <b>raw html</b> & "quotes"\n\n```js\nconst a = 1;\n```';
    expect(buildMarkdownExport('T', undefined, body)).toContain(body);
  });
});

describe('buildExportActionsHtml', () => {
  it('renders a download anchor per format, with no script', () => {
    const html = buildExportActionsHtml('/p/r/abc123', ['md', 'html']);
    expect(html).toContain('href="/p/r/abc123?export=md" download');
    expect(html).toContain('href="/p/r/abc123?export=html" download');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
  });

  it('renders nothing when there is no path or no offerable format', () => {
    expect(buildExportActionsHtml('/p/r/abc123', [])).toBe('');
    expect(buildExportActionsHtml('', ['html'])).toBe('');
  });

  it('escapes the viewer path into the href', () => {
    const html = buildExportActionsHtml('/a/tok"onmouseover=alert(1)', ['html']);
    expect(html).not.toContain('"onmouseover');
    expect(html).toContain('&quot;onmouseover');
  });
});

describe('EXPORT_CONTENT_TYPE / exportHref', () => {
  it('maps each format to its charset-qualified type', () => {
    expect(EXPORT_CONTENT_TYPE.md).toBe('text/markdown; charset=utf-8');
    expect(EXPORT_CONTENT_TYPE.html).toBe('text/html; charset=utf-8');
  });

  it('builds the query for both viewer path shapes', () => {
    expect(exportHref('/p/u/user1/my-slug', 'html')).toBe('/p/u/user1/my-slug?export=html');
    expect(exportHref('/a/token123', 'md')).toBe('/a/token123?export=md');
  });
});
