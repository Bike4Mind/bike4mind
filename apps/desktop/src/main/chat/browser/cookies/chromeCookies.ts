import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import type { CookieSkipReason } from '@shared/browserCookies';

/**
 * Chrome's own cookie encryption on macOS, read back.
 *
 * The constants are Chromium's, from components/os_crypt/sync/os_crypt_mac.mm: PBKDF2-SHA1 over
 * the Keychain password with the fixed salt "saltysalt" and 1003 rounds, giving a 128-bit AES
 * key used in CBC with an IV of sixteen spaces. None of them is a choice, and getting one wrong
 * does not fail - it yields plausible bytes - which is why what comes out is checked below
 * rather than trusted.
 *
 * Everything in this file is pure. The Keychain, the filesystem and the jar are next door in
 * chromeCookieSource.ts and CookieImporter.ts, so this half can be tested against fixtures
 * built in the test rather than against anybody's real profile.
 */

const SALT = 'saltysalt';
const ITERATIONS = 1003;
const KEY_BYTES = 16;
const BLOCK_BYTES = 16;
const IV = Buffer.alloc(BLOCK_BYTES, 0x20);
/** The only format this reads. Anything else is a cookie it declines rather than guesses at. */
const VERSION_PREFIX = 'v10';
const DOMAIN_HASH_BYTES = 32;

/**
 * Microseconds between 1601-01-01, which is where Chrome counts from, and the Unix epoch.
 *
 * Both the unit and the origin differ from everything else here. Read as Unix milliseconds, a
 * current Chrome timestamp lands some four hundred centuries from now, and every expiry test it
 * is given then passes - which is how a wrong conversion drops or admits a whole store in
 * silence instead of failing.
 */
const CHROME_EPOCH_OFFSET_US = 11_644_473_600_000_000n;

export function deriveChromeKey(password: Buffer): Buffer {
  return pbkdf2Sync(password, SALT, ITERATIONS, KEY_BYTES, 'sha1');
}

export type DecryptedValue = { ok: true; value: string } | { ok: false; reason: CookieSkipReason };

/**
 * One cookie value, or why it cannot be had.
 *
 * `hostKey` is not decoration: since Chrome 130 the host is hashed into the plaintext before
 * encryption, and rows written before that migration sit in the same database with no such
 * prefix - so whether to strip one is decided per row, by whether the hash is actually there,
 * rather than from the database's version.
 */
export function decryptCookieValue(encrypted: Buffer, hostKey: string, key: Buffer): DecryptedValue {
  if (encrypted.subarray(0, VERSION_PREFIX.length).toString('latin1') !== VERSION_PREFIX) {
    return { ok: false, reason: 'unsupported-format' };
  }
  const body = encrypted.subarray(VERSION_PREFIX.length);
  if (body.length === 0 || body.length % BLOCK_BYTES !== 0) return { ok: false, reason: 'unsupported-format' };

  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, IV);
    plain = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return { ok: false, reason: 'undecryptable' };
  }

  const bound = createHash('sha256').update(hostKey).digest();
  if (plain.length >= DOMAIN_HASH_BYTES && plain.subarray(0, DOMAIN_HASH_BYTES).equals(bound)) {
    plain = plain.subarray(DOMAIN_HASH_BYTES);
  }

  const value = plain.toString('utf8');
  // A wrong key clears PKCS#7 unpadding roughly once in 256 tries, and what it leaves is bytes.
  // RFC 6265 lets no control character into a cookie value, so one here says the same thing a
  // padding error does, and this is the check that keeps garbage out of the jar.
  if (!isCookieValue(value)) return { ok: false, reason: 'undecryptable' };
  return { ok: true, value };
}

function isCookieValue(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** When a row expires, as Unix seconds, or null for a cookie Chrome holds until the browser goes. */
export function chromeExpiryToUnixSeconds(expiresUtc: bigint): number | null {
  if (expiresUtc <= 0n) return null;
  return Number((expiresUtc - CHROME_EPOCH_OFFSET_US) / 1_000_000n);
}

/** A row of Chrome's cookies table, as far as an import cares about it. */
export interface ChromeCookieRow {
  hostKey: string;
  name: string;
  path: string;
  encryptedValue: Buffer;
  /** Microseconds since 1601, which is past what a number holds exactly; hence bigint. */
  expiresUtc: bigint;
  isSecure: boolean;
  isHttpOnly: boolean;
  /** Chromium's CookieSameSite: -1 unspecified, 0 none, 1 lax, 2 strict. */
  sameSite: number;
}

/** What goes into the agent's jar: Electron's cookie details, minus what is deliberately unset. */
export interface ImportableCookie {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

export type MappedCookie = { ok: true; cookie: ImportableCookie } | { ok: false; reason: CookieSkipReason };

function sameSiteOf(value: number): ImportableCookie['sameSite'] {
  if (value === 0) return 'no_restriction';
  if (value === 1) return 'lax';
  if (value === 2) return 'strict';
  return 'unspecified';
}

/** A host as the chooser lists it and as the jar is asked about it: no leading dot, lowercase. */
export function siteOf(hostKey: string): string {
  return hostKey.replace(/^\./, '').toLowerCase();
}

/** The host_key values one named site covers: the site itself, and its domain-cookie form. */
export function hostKeysFor(site: string): string[] {
  const host = siteOf(site);
  return [host, `.${host}`];
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Whether a site the renderer named is one that could be a host at all. */
export function isImportableSite(site: string): boolean {
  const host = siteOf(site);
  return host.length > 0 && host.length <= 253 && HOSTNAME.test(host);
}

/**
 * A decrypted row as the jar wants it, or why it stays behind.
 *
 * The expiry is read and then DROPPED. An imported cookie goes in without one, which makes it a
 * session cookie: Chromium's own rules then keep it out of the partition's on-disk store and it
 * cannot outlive this run of the app. That is the quit-scoped retention, enforced by the jar
 * rather than by remembering to tidy up. The timestamp is still needed to leave a cookie that
 * has ALREADY expired behind, instead of importing a dead one as a live session.
 */
export function toImportableCookie(row: ChromeCookieRow, value: string, nowSeconds: number): MappedCookie {
  const expiry = chromeExpiryToUnixSeconds(row.expiresUtc);
  if (expiry !== null && expiry <= nowSeconds) return { ok: false, reason: 'expired' };

  const host = siteOf(row.hostKey);
  if (!isImportableSite(host)) return { ok: false, reason: 'rejected' };

  const sameSite = sameSiteOf(row.sameSite);
  // Chromium refuses SameSite=None that is not Secure, so one imported would only be rejected
  // on the way in - and coercing either flag would send a cookie somewhere Chrome would not.
  if (sameSite === 'no_restriction' && !row.isSecure) return { ok: false, reason: 'rejected' };

  const path = row.path.startsWith('/') ? row.path : `/${row.path}`;
  return {
    ok: true,
    cookie: {
      url: `${row.isSecure ? 'https' : 'http'}://${host}${path}`,
      name: row.name,
      value,
      // A leading dot is Chrome saying "and every subdomain". Its absence is a host-only
      // cookie, which Electron expresses by leaving the host to the url rather than by a flag -
      // so the dot has to be carried through as a domain, and its absence as no domain at all.
      ...(row.hostKey.startsWith('.') ? { domain: row.hostKey } : {}),
      path,
      secure: row.isSecure,
      httpOnly: row.isHttpOnly,
      sameSite,
    },
  };
}

/** Whether a url would be reached carrying one of these sites' cookies. */
export function sitesCover(sites: Iterable<string>, url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  for (const site of sites) {
    // A domain cookie imported for example.com is sent to app.example.com as well, so this
    // follows the cookie rather than stopping at the name the user typed in the chooser.
    if (host === site || host.endsWith(`.${site}`)) return true;
  }
  return false;
}
