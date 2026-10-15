import { execFile } from 'node:child_process';
import { access, copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChromeCookieHost, ChromeProfile, CookieImportFailure } from '@shared/browserCookies';
import { hostKeysFor, siteOf, type ChromeCookieRow } from './chromeCookies';

/**
 * Where Chrome's cookies actually live, and how to get at them without disturbing them.
 *
 * Google Chrome on macOS only. Chrome Beta, Canary and Chromium keep their own Keychain items
 * under their own names, and Firefox and Safari do not use this format at all; half-reading any
 * of them would be worse than saying so.
 */

const CHROME_USER_DATA = ['Library', 'Application Support', 'Google', 'Chrome'];
const KEYCHAIN_SERVICE = 'Chrome Safe Storage';
const KEYCHAIN_ACCOUNT = 'Chrome';
/** Long enough for the user to find the Keychain prompt, short enough not to hang the import. */
const KEYCHAIN_TIMEOUT_MS = 120_000;

export function chromeUserDataDir(): string {
  return join(homedir(), ...CHROME_USER_DATA);
}

export function chromeCookiePath(root: string, profileDir: string): string {
  return join(root, profileDir, 'Cookies');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface LocalState {
  profile?: { info_cache?: Record<string, { name?: unknown } | undefined> };
}

/** The names Chrome shows in its own profile menu, keyed by directory. */
async function profileNames(root: string): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  try {
    const parsed = JSON.parse(await readFile(join(root, 'Local State'), 'utf8')) as LocalState;
    for (const [dir, info] of Object.entries(parsed.profile?.info_cache ?? {})) {
      if (typeof info?.name === 'string' && info.name.trim()) names[dir] = info.name.trim();
    }
  } catch {
    // No Local State, or not JSON this build understands. The directory names still name the
    // profiles well enough to pick between, so this is a missing nicety rather than a failure.
  }
  return names;
}

/**
 * Every profile with a cookie store, found by looking rather than by trusting Local State:
 * a profile directory outlives its entry there, and the file is what an import actually reads.
 */
export async function listChromeProfiles(root = chromeUserDataDir()): Promise<ChromeProfile[]> {
  const names = await profileNames(root);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const profiles: ChromeProfile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!(await exists(chromeCookiePath(root, entry.name)))) continue;
    profiles.push({ dir: entry.name, name: names[entry.name] ?? entry.name, primary: entry.name === 'Default' });
  }
  return profiles.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
}

/**
 * Chrome's cookie database, opened on a COPY of itself.
 *
 * Never the original. Chrome holds it locked while it is running, and an open that SQLite
 * decided to recover would be this app writing into the user's live profile. The write-ahead
 * log is copied alongside it, or the snapshot would be missing everything since the last
 * checkpoint, and the whole temporary directory goes at the end whatever happened.
 */
async function withCookieDb<T>(cookiePath: string, use: (db: DatabaseSync) => T): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'b4m-cookies-'));
  try {
    const copy = join(dir, 'Cookies');
    await copyFile(cookiePath, copy);
    for (const suffix of ['-wal', '-shm']) {
      await copyFile(`${cookiePath}${suffix}`, `${copy}${suffix}`).catch(() => undefined);
    }
    const db = new DatabaseSync(copy);
    try {
      return use(db);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The failure a caller should report for anything thrown out of a read here. */
export function readFailure(err: unknown): CookieImportFailure {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' ? 'no-profile' : 'unreadable';
}

function columnsOf(db: DatabaseSync): Set<string> {
  const rows = db.prepare('PRAGMA table_info(cookies)').all() as { name?: unknown }[];
  return new Set(rows.map(row => String(row.name)));
}

/**
 * Which sites this profile has cookies for, and how many each.
 *
 * Decrypts nothing and never touches the Keychain: host_key is stored in the clear, so the
 * chooser can be filled before the user has agreed to anything. The prompt comes later, once
 * they have said which of these they want.
 */
export async function readChromeCookieHosts(cookiePath: string): Promise<ChromeCookieHost[]> {
  return withCookieDb(cookiePath, db => {
    const rows = db.prepare('SELECT host_key, COUNT(*) AS n FROM cookies GROUP BY host_key').all() as {
      host_key?: unknown;
      n?: unknown;
    }[];
    const totals = new Map<string, number>();
    for (const row of rows) {
      const site = siteOf(String(row.host_key ?? ''));
      if (!site) continue;
      totals.set(site, (totals.get(site) ?? 0) + Number(row.n ?? 0));
    }
    return [...totals].map(([host, cookies]) => ({ host, cookies })).sort((a, b) => a.host.localeCompare(b.host));
  });
}

const REQUIRED_COLUMNS = ['host_key', 'name', 'path', 'encrypted_value'];
/** Columns Chrome has added over the years, with what to assume when a store predates one. */
const OPTIONAL_COLUMNS: Record<string, string> = {
  expires_utc: '0',
  is_secure: '0',
  is_httponly: '0',
  samesite: '-1',
};

/**
 * The rows for the named sites, and no others.
 *
 * Filtered in SQL rather than after reading, so the rest of the store is never loaded, never
 * decrypted and never anywhere this process could leak it: the Keychain key unlocks every site
 * Chrome has, and the narrowest point to stop is before the first value is read.
 */
export async function readChromeCookieRows(cookiePath: string, sites: readonly string[]): Promise<ChromeCookieRow[]> {
  const keys = sites.flatMap(hostKeysFor);
  if (keys.length === 0) return [];
  return withCookieDb(cookiePath, db => {
    const columns = columnsOf(db);
    const missing = REQUIRED_COLUMNS.filter(column => !columns.has(column));
    if (missing.length > 0) throw new Error('This Chrome cookie store has an unfamiliar layout.');
    // The timestamp comes back as text: it is microseconds since 1601, which is past what a
    // number holds exactly, and node:sqlite throws on such an integer rather than rounding it.
    const selected = [
      ...REQUIRED_COLUMNS,
      ...Object.entries(OPTIONAL_COLUMNS).map(([column, fallback]) =>
        columns.has(column)
          ? column === 'expires_utc'
            ? 'CAST(expires_utc AS TEXT) AS expires_utc'
            : column
          : `${fallback} AS ${column}`
      ),
    ].join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT ${selected} FROM cookies WHERE host_key IN (${placeholders})`)
      .all(...keys) as Record<string, unknown>[];
    return rows.map(toCookieRow);
  });
}

function toCookieRow(row: Record<string, unknown>): ChromeCookieRow {
  const encrypted = row.encrypted_value;
  return {
    hostKey: String(row.host_key ?? ''),
    name: String(row.name ?? ''),
    path: String(row.path ?? '/'),
    encryptedValue: encrypted instanceof Uint8Array ? Buffer.from(encrypted) : Buffer.alloc(0),
    expiresUtc: toBigInt(row.expires_utc),
    isSecure: Number(row.is_secure ?? 0) !== 0,
    isHttpOnly: Number(row.is_httponly ?? 0) !== 0,
    sameSite: Number(row.samesite ?? -1),
  };
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  try {
    return BigInt(String(value ?? '0').trim() || '0');
  } catch {
    return 0n;
  }
}

export type KeychainResult =
  | { ok: true; password: Buffer }
  | { ok: false; failure: Extract<CookieImportFailure, 'keychain-denied' | 'keychain-missing' | 'failed'> };

/**
 * Chrome's Safe Storage password, from the login Keychain.
 *
 * Asked for through `security` so the prompt is the one the user already knows and a refusal
 * comes back as an exit code rather than as a hang. What it returns is the password behind
 * EVERY site Chrome has ever stored, which is why it comes back as a buffer the caller can wipe
 * rather than as a string that would sit in the heap until something collected it - and why
 * nothing here logs the command's output, its error, or the fact that a particular item exists.
 */
export function readChromeSafeStoragePassword(): Promise<KeychainResult> {
  return new Promise(resolve => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-w', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT],
      { encoding: 'buffer', timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (!error) {
          const password = trimTrailingNewlines(stdout);
          stdout.fill(0);
          resolve(password.length > 0 ? { ok: true, password } : { ok: false, failure: 'keychain-missing' });
          return;
        }
        const code = (error as { code?: unknown }).code;
        // 128 is the user clicking Deny on the Keychain prompt; 44 is errSecItemNotFound, i.e.
        // Chrome has never stored a key on this machine. Everything else is its own problem.
        if (code === 128) resolve({ ok: false, failure: 'keychain-denied' });
        else if (code === 44) resolve({ ok: false, failure: 'keychain-missing' });
        else resolve({ ok: false, failure: 'failed' });
      }
    );
  });
}

function trimTrailingNewlines(raw: Buffer): Buffer {
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === 0x0a || raw[end - 1] === 0x0d)) end -= 1;
  return Buffer.from(raw.subarray(0, end));
}
