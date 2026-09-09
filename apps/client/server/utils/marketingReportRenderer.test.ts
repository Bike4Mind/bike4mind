import { describe, it, expect } from 'vitest';
import { renderMarkdown, sanitizeReportHtml, renderAndSanitize } from './marketingReportRenderer';

describe('renderMarkdown', () => {
  it('converts markdown headings to HTML', () => {
    expect(renderMarkdown('## Hello')).toContain('<h2>Hello</h2>');
  });

  it('converts markdown lists', () => {
    const result = renderMarkdown('- item one\n- item two');
    expect(result).toContain('<li>item one</li>');
  });
});

describe('sanitizeReportHtml', () => {
  it('strips script tags', () => {
    const result = sanitizeReportHtml('<script>alert(1)</script><p>safe</p>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('<p>safe</p>');
  });

  it('strips onclick attributes', () => {
    const result = sanitizeReportHtml('<p onclick="alert(1)">text</p>');
    expect(result).not.toContain('onclick');
    expect(result).toContain('<p>text</p>');
  });

  it('strips javascript: href', () => {
    const result = sanitizeReportHtml('<a href="javascript:alert(1)">click</a>');
    expect(result).not.toContain('javascript:');
  });

  it('strips data: image src (only remotely hosted images allowed)', () => {
    const result = sanitizeReportHtml('<img src="data:image/png;base64,abc123" alt="x">');
    expect(result).not.toContain('data:');
  });

  it('preserves allowed tags and attributes', () => {
    const result = sanitizeReportHtml('<p class="intro"><strong>Bold</strong></p>');
    expect(result).toContain('<p class="intro">');
    expect(result).toContain('<strong>Bold</strong>');
  });

  it("keeps img tags with an https src (what's-new emails embed images)", () => {
    const result = sanitizeReportHtml('<img src="https://example.com/img.png" alt="test">');
    expect(result).toContain('<img');
    expect(result).toContain('https://example.com/img.png');
    expect(result).toContain('alt="test"');
  });

  it('strips a javascript: img src while keeping the tag', () => {
    const result = sanitizeReportHtml('<img src="javascript:alert(1)" alt="x">');
    expect(result).not.toContain('javascript:');
  });

  it('strips style attribute', () => {
    const result = sanitizeReportHtml('<p style="color:red">text</p>');
    expect(result).not.toContain('style=');
  });

  it('strips id attribute', () => {
    const result = sanitizeReportHtml('<p id="my-id">text</p>');
    expect(result).not.toContain('id=');
  });
});

describe('renderAndSanitize', () => {
  it('is byte-identical to manual render+sanitize pipeline', () => {
    const md = '## XSS Test\n\n<script>alert(1)</script>\n\nSafe **content**.';
    const manual = sanitizeReportHtml(renderMarkdown(md));
    const combined = renderAndSanitize(md);
    expect(combined).toBe(manual);
  });

  it('strips XSS payloads in markdown', () => {
    const md = '[click me](javascript:alert(1))';
    const result = renderAndSanitize(md);
    expect(result).not.toContain('javascript:');
  });

  it('keeps a markdown-embedded image', () => {
    const result = renderAndSanitize('![logo](https://example.com/logo.png)');
    expect(result).toContain('<img');
    expect(result).toContain('https://example.com/logo.png');
  });
});
