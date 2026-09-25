import { describe, it, expect } from 'vitest';
import { isBrowserOpenableUrl } from './LoginFlow';

describe('isBrowserOpenableUrl', () => {
  it('accepts https URLs', () => {
    expect(isBrowserOpenableUrl('https://auth.example.com/device?code=ABC')).toBe(true);
  });

  it('accepts http only on localhost (dev)', () => {
    expect(isBrowserOpenableUrl('http://localhost:3000/verify')).toBe(true);
    expect(isBrowserOpenableUrl('http://127.0.0.1:3000/verify')).toBe(true);
    expect(isBrowserOpenableUrl('http://evil.example.com/verify')).toBe(false);
  });

  it('rejects non-web schemes a hostile server could inject', () => {
    expect(isBrowserOpenableUrl('file:///etc/passwd')).toBe(false);
    expect(isBrowserOpenableUrl('javascript:alert(1)')).toBe(false);
    expect(isBrowserOpenableUrl('data:text/html,<script>1</script>')).toBe(false);
    expect(isBrowserOpenableUrl('not a url')).toBe(false);
  });
});
