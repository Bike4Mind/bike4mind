import { describe, it, expect } from 'vitest';
import { escapeHtml, wrapEmail } from './notificationEmail';

describe('escapeHtml', () => {
  it('escapes all HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });

  it('escapes ampersands first so entities are not double-decoded', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves plain text untouched', () => {
    expect(escapeHtml('My Lake 1')).toBe('My Lake 1');
  });
});

describe('wrapEmail', () => {
  it('wraps the body in a div with a grey footer line', () => {
    expect(wrapEmail('<p>Hi</p>', 'Footer')).toBe(
      '<div><p>Hi</p><p style="color:#666;font-size:12px">Footer</p></div>'
    );
  });
});
