import { describe, it, expect } from 'vitest';
import { escapeHtml } from './escapeHtml';

describe('escapeHtml', () => {
  it('escapes all five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });

  it('escapes ampersands first so emitted entities are not double-escaped', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('escapes every occurrence, not just the first', () => {
    expect(escapeHtml('a<b<c')).toBe('a&lt;b&lt;c');
  });

  it('leaves plain text and the empty string untouched', () => {
    expect(escapeHtml('My Lake 1')).toBe('My Lake 1');
    expect(escapeHtml('')).toBe('');
  });
});
