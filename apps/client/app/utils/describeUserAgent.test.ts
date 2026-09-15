import { describe, it, expect } from 'vitest';
import { describeUserAgent } from './describeUserAgent';

describe('describeUserAgent', () => {
  it('falls back gracefully on missing / empty UA', () => {
    for (const ua of [undefined, null, '', '   ']) {
      expect(describeUserAgent(ua)).toEqual({
        browser: 'Unknown browser',
        os: 'Unknown OS',
        label: 'Unknown device',
      });
    }
  });

  it('detects Chrome on Windows (Chrome UA also contains Safari - order matters)', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    expect(describeUserAgent(ua)).toEqual({ browser: 'Chrome', os: 'Windows', label: 'Chrome on Windows' });
  });

  it('detects Safari on macOS', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
    expect(describeUserAgent(ua)).toEqual({ browser: 'Safari', os: 'macOS', label: 'Safari on macOS' });
  });

  it('detects Safari on iPhone (iOS UA carries "Mac OS X" - iPhone must win)', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    expect(describeUserAgent(ua)).toEqual({ browser: 'Safari', os: 'iPhone', label: 'Safari on iPhone' });
  });

  it('detects Chrome on Android', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
    expect(describeUserAgent(ua)).toEqual({ browser: 'Chrome', os: 'Android', label: 'Chrome on Android' });
  });

  it('detects Edge (contains Chrome + Safari tokens - Edge must win)', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0';
    expect(describeUserAgent(ua)).toEqual({ browser: 'Edge', os: 'Windows', label: 'Edge on Windows' });
  });

  it('detects Firefox on Linux', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0';
    expect(describeUserAgent(ua)).toEqual({ browser: 'Firefox', os: 'Linux', label: 'Firefox on Linux' });
  });

  it('labels by browser alone when OS is unknown', () => {
    expect(describeUserAgent('Chrome/120.0').label).toBe('Chrome');
  });

  it('labels by OS alone when browser is unknown (e.g. a non-browser client)', () => {
    expect(describeUserAgent('curl/8.4.0 (Windows NT 10.0)').label).toBe('Windows');
  });

  it('labels "Unknown device" when neither is recognized', () => {
    expect(describeUserAgent('SomeOpaqueClient/1.0').label).toBe('Unknown device');
  });
});
