import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isLocalAppUrl } from './validators';

describe('isLocalAppUrl', () => {
  // The signature defaults to process.env.APP_URL, so ambient state would leak into
  // every case that means to test an explicit argument - and into the absent-input
  // case especially. Mirrors csrfProtection.test.ts, which saves/restores for the
  // same reason.
  const originalAppUrl = process.env.APP_URL;
  beforeEach(() => {
    delete process.env.APP_URL;
  });
  afterEach(() => {
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
  });

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
    // '' hits the !appUrl guard directly; `undefined` falls through to the default
    // parameter, so it only exercises the absent path because the hook above
    // cleared APP_URL. Both are asserted deliberately.
    expect(isLocalAppUrl('')).toBe(false);
    expect(isLocalAppUrl(undefined)).toBe(false);
    expect(isLocalAppUrl('not a url')).toBe(false);
  });

  it('reads APP_URL when called with no argument', () => {
    process.env.APP_URL = 'http://localhost:3000';
    expect(isLocalAppUrl()).toBe(true);
    process.env.APP_URL = 'https://app.example.com';
    expect(isLocalAppUrl()).toBe(false);
  });
});
