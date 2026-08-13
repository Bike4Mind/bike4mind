import { describe, it, expect } from 'vitest';
import { isPrivateIP, isPrivateOrInternalHostname, validateUrlForFetch } from './ssrfProtection';

/**
 * Bracketed IPv6 was a live SSRF bypass: `new URL('http://[::1]/').hostname` is `'[::1]'`, and every
 * literal check compared against unbracketed forms, so a bracketed address matched nothing, was then
 * treated as an IP literal (so DNS validation was skipped) and returned valid. Reachable through the
 * LLM URL-fetch path and Files Manager Add-from-URL, and as a `Location:` value it also defeated the
 * per-hop redirect revalidation this module exists to provide.
 */
describe('SSRF - bracketed IPv6 literals', () => {
  it.each([
    ['loopback', 'http://[::1]/'],
    ['loopback with a port', 'http://[::1]:8080/admin'],
    ['unspecified', 'http://[::]/'],
    ['unique-local', 'http://[fd00::1]/'],
    ['link-local', 'http://[fe80::1]/'],
    ['IPv4-mapped metadata endpoint, dotted', 'http://[::ffff:169.254.169.254]/latest/meta-data/'],
    ['IPv4-mapped metadata endpoint, hex', 'http://[::ffff:a9fe:a9fe]/latest/meta-data/'],
    ['IPv4-mapped loopback, hex', 'http://[::ffff:7f00:1]/'],
  ])('refuses %s', async (_label, url) => {
    await expect(validateUrlForFetch(url)).resolves.toMatchObject({ valid: false });
  });

  it('blocks the bracketed forms at the hostname level too', () => {
    expect(isPrivateOrInternalHostname('[::1]')).toBe(true);
    expect(isPrivateOrInternalHostname('[fd00::1]')).toBe(true);
    expect(isPrivateIP('[::1]')).toBe(true);
  });

  it('still recognises the unbracketed forms it always did', () => {
    expect(isPrivateIP('::1')).toBe(true);
    expect(isPrivateIP('fe80::1')).toBe(true);
    expect(isPrivateIP('::ffff:169.254.169.254')).toBe(true);
  });
});

describe('isPrivateIP - non-canonical (leading-zero) IPv4 octets', () => {
  it('blocks a form that a decimal parser reads as public but inet_aton reads as loopback', () => {
    // `Number('0177')` is 177, so the old check saw 177.0.0.1 and allowed it - while an inet_aton
    // style parser reads 0177 as octal 127 and dials loopback. The string is ambiguous, so it is
    // refused rather than resolved one way and fetched the other.
    expect(isPrivateIP('0177.0.0.1')).toBe(true);
    expect(isPrivateOrInternalHostname('0177.0.0.1')).toBe(true);
  });

  it('blocks a leading-zero octet even where both readings are public', () => {
    // 010 is 8 (octal) or 10 (decimal); we do not care which, only that we cannot know.
    expect(isPrivateIP('010.0.0.1')).toBe(true);
  });

  it('blocks octal forms of the cloud metadata endpoint', () => {
    expect(isPrivateIP('0251.0376.0.0')).toBe(true);
  });

  it('does not over-block canonical addresses, including a legitimate single zero octet', () => {
    expect(isPrivateIP('93.184.216.34')).toBe(false);
    expect(isPrivateIP('8.8.8.8')).toBe(false);
    // A bare '0' octet is canonical - only a zero followed by more digits is ambiguous.
    expect(isPrivateIP('1.0.0.1')).toBe(false);
  });
});

describe('isPrivateIP - RFC 2544 benchmarking range (issue #8157)', () => {
  it('blocks 198.18.0.0/15', () => {
    expect(isPrivateIP('198.18.0.0')).toBe(true);
    expect(isPrivateIP('198.18.0.1')).toBe(true);
    expect(isPrivateIP('198.18.255.255')).toBe(true);
    expect(isPrivateIP('198.19.0.0')).toBe(true);
    expect(isPrivateIP('198.19.255.255')).toBe(true);
  });

  it('blocks the IPv4-mapped IPv6 form of the range', () => {
    expect(isPrivateIP('::ffff:198.18.0.1')).toBe(true);
    expect(isPrivateIP('::ffff:198.17.0.1')).toBe(false);
  });

  it('does not over-block adjacent public ranges', () => {
    expect(isPrivateIP('198.17.255.255')).toBe(false);
    expect(isPrivateIP('198.20.0.0')).toBe(false);
  });

  it('blocks 198.18.x.x literal hostnames', () => {
    expect(isPrivateOrInternalHostname('198.18.0.1')).toBe(true);
    expect(isPrivateOrInternalHostname('198.19.42.42')).toBe(true);
  });
});
