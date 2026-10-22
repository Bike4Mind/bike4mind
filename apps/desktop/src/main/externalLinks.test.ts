import { describe, expect, it } from 'vitest';
import { isExternallyOpenable } from './externalLinks';

describe('isExternallyOpenable', () => {
  it.each(['http://example.com', 'https://example.com/a?b=c#d', 'mailto:someone@example.com'])('opens %s', url => {
    expect(isExternallyOpenable(url)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ms-msdt:/id',
    'smb://host/share',
    'app://index.html',
    'chrome://settings',
    '/etc/passwd',
    './relative/path',
    '',
    'not a url',
  ])('refuses %s', url => {
    expect(isExternallyOpenable(url)).toBe(false);
  });

  it('refuses a url whose scheme only looks allowed after a prefix', () => {
    expect(isExternallyOpenable('x-http://example.com')).toBe(false);
  });
});
