import { describe, it, expect } from 'vitest';
import { isLocalAppUrl } from './validators';

describe('isLocalAppUrl', () => {
  it('matches the localhost dev origin, case-insensitively', () => {
    expect(isLocalAppUrl('http://localhost:3000')).toBe(true);
    expect(isLocalAppUrl('http://LOCALHOST:3000')).toBe(true);
  });

  it('does not fire on a value that merely contains the word', () => {
    // The bug this replaced: a substring test on the raw env value.
    expect(isLocalAppUrl('https://app.example.com/localhost')).toBe(false);
    expect(isLocalAppUrl('https://localhost.example.com')).toBe(false);
    expect(isLocalAppUrl('https://mylocalhost.com')).toBe(false);
  });

  it('does NOT admit loopback IPs - header-trust is narrower than the HTTPS exemption', () => {
    // validateAppUrl allows these to skip HTTPS; trusting x-forwarded-proto/host
    // for an OAuth redirect_uri is a higher-stakes decision and must not inherit
    // that set. WHATWG parsing normalizes several innocuous-looking values onto
    // these two, which is exactly why they stay out.
    for (const url of [
      'http://127.0.0.1:3000',
      'http://0.0.0.0:3000',
      'http://0',
      'http://0x0',
      'http://127.1',
      'http://2130706433',
    ]) {
      expect(isLocalAppUrl(url)).toBe(false);
    }
  });

  it('treats a trailing dot as a different name', () => {
    expect(isLocalAppUrl('http://localhost.')).toBe(false);
  });

  it('fails closed on absent or unparseable values', () => {
    expect(isLocalAppUrl(undefined)).toBe(false);
    expect(isLocalAppUrl('')).toBe(false);
    expect(isLocalAppUrl('not a url')).toBe(false);
  });
});
