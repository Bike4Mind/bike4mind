import { describe, expect, it } from 'vitest';
import { normalizeUrl, resolveAddress } from './browserUrl';

describe('normalizeUrl', () => {
  it('gives a bare host a scheme, https off the machine and http on it', () => {
    expect(normalizeUrl('example.com/cart')).toBe('https://example.com/cart');
    expect(normalizeUrl('localhost:3080')).toBe('http://localhost:3080/');
    expect(normalizeUrl('[::1]:3000')).toBe('http://[::1]:3000/');
  });

  it('leaves a url that already has one alone', () => {
    expect(normalizeUrl('  https://example.com/a?b=1  ')).toBe('https://example.com/a?b=1');
  });

  // The whole point of routing both the agent and the url bar through here. A file: url in this
  // browser reads the user's disk through a surface the granted-roots checks never see.
  it('refuses every scheme that is not http or https', () => {
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow(/http and https/);
    expect(() => normalizeUrl('b4m-media:12345')).toThrow(/http and https/);
    expect(() => normalizeUrl('b4m-artifact:abc')).toThrow(/http and https/);
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow(/http and https/);
  });
});

describe('resolveAddress', () => {
  it('opens anything that looks like an address', () => {
    expect(resolveAddress('example.com')).toEqual({ ok: true, url: 'https://example.com/' });
    expect(resolveAddress('127.0.0.1:5173/app')).toEqual({ ok: true, url: 'http://127.0.0.1:5173/app' });
    expect(resolveAddress('localhost')).toEqual({ ok: true, url: 'http://localhost/' });
  });

  it('searches for anything that does not', () => {
    expect(resolveAddress('joy slot props')).toEqual({
      ok: true,
      url: 'https://duckduckgo.com/?q=joy%20slot%20props',
    });
    expect(resolveAddress('vitest')).toEqual({ ok: true, url: 'https://duckduckgo.com/?q=vitest' });
  });

  // A refused scheme has to come back as a refusal the user can read. Quietly searching the web
  // for "file:///etc/passwd" would look like the bar simply ignored them.
  it('refuses a written-out scheme rather than searching for it', () => {
    expect(resolveAddress('file:///etc/passwd')).toEqual({
      ok: false,
      error: 'Only http and https pages can be opened, not file:',
    });
  });

  it('says so when nothing was typed', () => {
    expect(resolveAddress('   ')).toMatchObject({ ok: false });
  });
});
