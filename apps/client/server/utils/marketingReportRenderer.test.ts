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

  it('strips data: image src', () => {
    const result = sanitizeReportHtml('<img src="data:image/png;base64,abc123" alt="x">');
    expect(result).not.toContain('data:');
  });

  it('preserves allowed tags and attributes', () => {
    const result = sanitizeReportHtml('<p class="intro"><strong>Bold</strong></p>');
    expect(result).toContain('<p class="intro">');
    expect(result).toContain('<strong>Bold</strong>');
  });

  it('strips img tags (no external asset loads)', () => {
    const result = sanitizeReportHtml('<img src="https://example.com/img.png" alt="test">');
    expect(result).not.toContain('<img');
    expect(result).not.toContain('https://example.com/img.png');
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
});
