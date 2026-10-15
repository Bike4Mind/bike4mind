import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  chromeExpiryToUnixSeconds,
  decryptCookieValue,
  deriveChromeKey,
  hostKeysFor,
  isImportableSite,
  siteOf,
  sitesCover,
  toImportableCookie,
  type ChromeCookieRow,
} from './chromeCookies';

/**
 * Fixtures built here, never read from anybody's profile: the point of these tests is that the
 * format is implemented right, and a real store would make them depend on whatever Chrome
 * happened to have written on the machine that ran them.
 */
const PASSWORD = Buffer.from('not-a-real-safe-storage-key');
const KEY = deriveChromeKey(PASSWORD);
const IV = Buffer.alloc(16, 0x20);

/** Chrome's own encryption, so what the tests decrypt is what Chrome would have written. */
function encrypt(value: string, hostKey: string | null): Buffer {
  const cipher = createCipheriv('aes-128-cbc', KEY, IV);
  const prefix = hostKey === null ? Buffer.alloc(0) : createHash('sha256').update(hostKey).digest();
  const body = Buffer.concat([prefix, Buffer.from(value, 'utf8')]);
  return Buffer.concat([Buffer.from('v10'), cipher.update(body), cipher.final()]);
}

const CHROME_EPOCH_OFFSET_US = 11_644_473_600_000_000n;

function chromeTime(unixSeconds: number): bigint {
  return BigInt(unixSeconds) * 1_000_000n + CHROME_EPOCH_OFFSET_US;
}

function row(overrides: Partial<ChromeCookieRow> = {}): ChromeCookieRow {
  return {
    hostKey: '.example.com',
    name: 'session',
    path: '/',
    encryptedValue: Buffer.alloc(0),
    expiresUtc: chromeTime(2_000_000_000),
    isSecure: true,
    isHttpOnly: true,
    sameSite: 1,
    ...overrides,
  };
}

describe('deriveChromeKey', () => {
  it('derives the 128-bit key Chromium derives', () => {
    expect(KEY).toEqual(pbkdf2Sync(PASSWORD, 'saltysalt', 1003, 16, 'sha1'));
    expect(KEY).toHaveLength(16);
  });
});

describe('decryptCookieValue', () => {
  it('reads a value written with the host hashed into it, as Chrome 130 and later do', () => {
    const result = decryptCookieValue(encrypt('abc123', '.example.com'), '.example.com', KEY);
    expect(result).toEqual({ ok: true, value: 'abc123' });
  });

  it('reads a value from before that migration, in the same store', () => {
    const result = decryptCookieValue(encrypt('abc123', null), '.example.com', KEY);
    expect(result).toEqual({ ok: true, value: 'abc123' });
  });

  it('keeps a value that merely starts with 32 bytes of its own', () => {
    const value = 'x'.repeat(40);
    expect(decryptCookieValue(encrypt(value, null), '.example.com', KEY)).toEqual({ ok: true, value });
  });

  it('does not strip another host that hashed into the same length', () => {
    // The row's host is what binds it: a prefix matching a DIFFERENT host is part of the value.
    const result = decryptCookieValue(encrypt('abc', '.other.com'), '.example.com', KEY);
    expect(result).toEqual({ ok: false, reason: 'undecryptable' });
  });

  it('skips a version prefix it does not know rather than writing garbage', () => {
    const encrypted = encrypt('abc123', null);
    encrypted.write('v20', 0, 'latin1');
    expect(decryptCookieValue(encrypted, '.example.com', KEY)).toEqual({
      ok: false,
      reason: 'unsupported-format',
    });
  });

  it('skips a value with no prefix at all', () => {
    expect(decryptCookieValue(Buffer.from('plain text'), '.example.com', KEY)).toEqual({
      ok: false,
      reason: 'unsupported-format',
    });
  });

  it('skips a body that is not whole blocks', () => {
    expect(decryptCookieValue(Buffer.concat([Buffer.from('v10'), Buffer.alloc(7)]), 'x', KEY)).toEqual({
      ok: false,
      reason: 'unsupported-format',
    });
  });

  it('skips rather than returning anything when the key is wrong', () => {
    const wrong = deriveChromeKey(Buffer.from('a different password'));
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = decryptCookieValue(encrypt(`value-${attempt}`, '.example.com'), '.example.com', wrong);
      expect(result.ok).toBe(false);
    }
  });

  it('skips an empty blob', () => {
    expect(decryptCookieValue(Buffer.alloc(0), '.example.com', KEY)).toEqual({
      ok: false,
      reason: 'unsupported-format',
    });
  });
});

describe('chromeExpiryToUnixSeconds', () => {
  it('converts from microseconds since 1601', () => {
    expect(chromeExpiryToUnixSeconds(chromeTime(1_700_000_000))).toBe(1_700_000_000);
  });

  it('reads zero as a cookie that does not expire', () => {
    expect(chromeExpiryToUnixSeconds(0n)).toBeNull();
  });

  it('stays exact at a magnitude a number cannot hold', () => {
    // A current Chrome timestamp is past Number.MAX_SAFE_INTEGER, so an odd microsecond count
    // does not survive the trip through a number at all. This is why the column is read as text
    // and converted as a bigint, and the test is here to say so if that ever changes back.
    const stored = chromeTime(1_700_000_000) + 1n;
    expect(BigInt(Number(stored))).not.toBe(stored);
    expect(chromeExpiryToUnixSeconds(stored)).toBe(1_700_000_000);
  });
});

describe('toImportableCookie', () => {
  const now = 1_700_000_000;

  it('carries a domain cookie across with its dot', () => {
    const mapped = toImportableCookie(row(), 'abc', now);
    expect(mapped).toEqual({
      ok: true,
      cookie: {
        url: 'https://example.com/',
        name: 'session',
        value: 'abc',
        domain: '.example.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
      },
    });
  });

  it('leaves a host-only cookie without a domain', () => {
    const mapped = toImportableCookie(row({ hostKey: 'example.com' }), 'abc', now);
    expect(mapped.ok && mapped.cookie.domain).toBeUndefined();
    expect(mapped.ok && mapped.cookie.url).toBe('https://example.com/');
  });

  it('never sets an expiry, so an imported cookie is a session cookie', () => {
    const mapped = toImportableCookie(row(), 'abc', now);
    expect(mapped.ok && 'expirationDate' in mapped.cookie).toBe(false);
  });

  it('imports a cookie Chrome holds until the browser goes', () => {
    expect(toImportableCookie(row({ expiresUtc: 0n }), 'abc', now).ok).toBe(true);
  });

  it('leaves an expired cookie behind rather than reviving it as a session', () => {
    expect(toImportableCookie(row({ expiresUtc: chromeTime(now - 1) }), 'abc', now)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('maps every SameSite Chromium stores', () => {
    const of = (sameSite: number) => {
      const mapped = toImportableCookie(row({ sameSite }), 'abc', now);
      return mapped.ok ? mapped.cookie.sameSite : mapped.reason;
    };
    expect(of(-1)).toBe('unspecified');
    expect(of(0)).toBe('no_restriction');
    expect(of(1)).toBe('lax');
    expect(of(2)).toBe('strict');
  });

  it('refuses SameSite=None that is not Secure, which Chromium would reject anyway', () => {
    expect(toImportableCookie(row({ sameSite: 0, isSecure: false }), 'abc', now)).toEqual({
      ok: false,
      reason: 'rejected',
    });
  });

  it('builds an http url for a cookie that is not secure', () => {
    const mapped = toImportableCookie(row({ isSecure: false, hostKey: 'localhost' }), 'abc', now);
    expect(mapped.ok && mapped.cookie.url).toBe('http://localhost/');
  });

  it('keeps the path the cookie was scoped to', () => {
    const mapped = toImportableCookie(row({ path: '/app' }), 'abc', now);
    expect(mapped.ok && mapped.cookie.url).toBe('https://example.com/app');
    expect(mapped.ok && mapped.cookie.path).toBe('/app');
  });

  it('refuses a host_key that is not a hostname', () => {
    expect(toImportableCookie(row({ hostKey: 'not a host/' }), 'abc', now)).toEqual({
      ok: false,
      reason: 'rejected',
    });
  });
});

describe('site names', () => {
  it('collapses the dotted and undotted forms of one site', () => {
    expect(siteOf('.Example.COM')).toBe('example.com');
    expect(siteOf('example.com')).toBe('example.com');
  });

  it('covers both forms when reading a site out of the store', () => {
    expect(hostKeysFor('Example.com')).toEqual(['example.com', '.example.com']);
  });

  it('accepts a hostname and refuses anything else', () => {
    expect(isImportableSite('example.com')).toBe(true);
    expect(isImportableSite('localhost')).toBe(true);
    expect(isImportableSite('')).toBe(false);
    expect(isImportableSite('example.com/path')).toBe(false);
    expect(isImportableSite('http://example.com')).toBe(false);
    expect(isImportableSite('a'.repeat(254))).toBe(false);
  });
});

describe('sitesCover', () => {
  it('covers the site itself and its subdomains, the way a domain cookie is sent', () => {
    expect(sitesCover(['example.com'], 'https://example.com/x')).toBe(true);
    expect(sitesCover(['example.com'], 'https://app.example.com/x')).toBe(true);
  });

  it('does not cover a name that merely ends the same way', () => {
    expect(sitesCover(['example.com'], 'https://notexample.com/')).toBe(false);
    expect(sitesCover(['example.com'], 'https://example.com.evil.test/')).toBe(false);
  });

  it('covers nothing when nothing is imported, and is unbothered by a bad url', () => {
    expect(sitesCover([], 'https://example.com/')).toBe(false);
    expect(sitesCover(['example.com'], 'not a url')).toBe(false);
  });
});
