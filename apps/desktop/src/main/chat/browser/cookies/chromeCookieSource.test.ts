import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chromeCookiePath,
  listChromeProfiles,
  readChromeCookieHosts,
  readChromeCookieRows,
} from './chromeCookieSource';

/**
 * A Chrome user data directory built here, row by row, so these tests say what the code does
 * with a store rather than what some particular machine's Chrome happened to contain.
 */
let root = '';

const SCHEMA = `CREATE TABLE cookies(
  creation_utc INTEGER NOT NULL,
  host_key TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  encrypted_value BLOB NOT NULL,
  path TEXT NOT NULL,
  expires_utc INTEGER NOT NULL,
  is_secure INTEGER NOT NULL,
  is_httponly INTEGER NOT NULL,
  samesite INTEGER NOT NULL)`;

interface SeedRow {
  host: string;
  name: string;
  expires?: bigint;
  secure?: number;
}

async function seedProfile(dir: string, rows: SeedRow[]): Promise<void> {
  await mkdir(join(root, dir), { recursive: true });
  const db = new DatabaseSync(chromeCookiePath(root, dir));
  db.exec(SCHEMA);
  const insert = db.prepare(
    'INSERT INTO cookies (creation_utc, host_key, name, value, encrypted_value, path, expires_utc,' +
      ' is_secure, is_httponly, samesite) VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const row of rows) {
    insert.run(
      row.host,
      row.name,
      '',
      Buffer.from(`v10${row.name}`),
      '/',
      row.expires ?? 13_790_390_400_000_000n,
      row.secure ?? 1,
      1,
      1
    );
  }
  db.close();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'b4m-chrome-fixture-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('listChromeProfiles', () => {
  it('finds every directory that actually has a cookie store', async () => {
    await seedProfile('Default', [{ host: 'example.com', name: 'a' }]);
    await seedProfile('Profile 1', [{ host: 'example.com', name: 'a' }]);
    await mkdir(join(root, 'Crashpad'), { recursive: true });
    await writeFile(
      join(root, 'Local State'),
      JSON.stringify({ profile: { info_cache: { 'Profile 1': { name: 'Work' } } } })
    );

    const profiles = await listChromeProfiles(root);

    expect(profiles).toEqual([
      { dir: 'Default', name: 'Default', primary: true },
      { dir: 'Profile 1', name: 'Work', primary: false },
    ]);
  });

  it('still lists a profile Local State has forgotten', async () => {
    await seedProfile('Profile 7', [{ host: 'example.com', name: 'a' }]);
    await writeFile(join(root, 'Local State'), 'not json');

    expect(await listChromeProfiles(root)).toEqual([{ dir: 'Profile 7', name: 'Profile 7', primary: false }]);
  });

  it('finds nothing when Chrome is not there', async () => {
    expect(await listChromeProfiles(join(root, 'absent'))).toEqual([]);
  });
});

describe('readChromeCookieHosts', () => {
  it('counts one site once, however Chrome scoped it', async () => {
    await seedProfile('Default', [
      { host: 'example.com', name: 'a' },
      { host: '.example.com', name: 'b' },
      { host: '.other.test', name: 'c' },
    ]);

    expect(await readChromeCookieHosts(chromeCookiePath(root, 'Default'))).toEqual([
      { host: 'example.com', cookies: 2 },
      { host: 'other.test', cookies: 1 },
    ]);
  });
});

describe('readChromeCookieRows', () => {
  beforeEach(async () => {
    await seedProfile('Default', [
      { host: 'example.com', name: 'host-only' },
      { host: '.example.com', name: 'domain' },
      { host: '.app.example.com', name: 'subdomain' },
      { host: 'bank.test', name: 'secret' },
      { host: '.other.test', name: 'other' },
    ]);
  });

  it('returns the named site only - not its subdomains and not anybody else', async () => {
    const rows = await readChromeCookieRows(chromeCookiePath(root, 'Default'), ['example.com']);

    expect(rows.map(row => row.name).sort()).toEqual(['domain', 'host-only']);
  });

  it('never reads a site that was not named, however many were', async () => {
    const rows = await readChromeCookieRows(chromeCookiePath(root, 'Default'), ['example.com', 'other.test']);

    expect(rows.map(row => row.hostKey).some(host => host.includes('bank'))).toBe(false);
    expect(rows).toHaveLength(3);
  });

  it('reads nothing at all when nothing was named', async () => {
    expect(await readChromeCookieRows(chromeCookiePath(root, 'Default'), [])).toEqual([]);
  });

  it('carries the expiry across without losing the low digits', async () => {
    await seedProfile('Exact', [{ host: 'example.com', name: 'a', expires: 13_790_390_400_000_001n }]);

    const [row] = await readChromeCookieRows(chromeCookiePath(root, 'Exact'), ['example.com']);

    expect(row.expiresUtc).toBe(13_790_390_400_000_001n);
  });

  it('reads a store that predates a column, rather than failing on it', async () => {
    await mkdir(join(root, 'Old'), { recursive: true });
    const db = new DatabaseSync(chromeCookiePath(root, 'Old'));
    db.exec('CREATE TABLE cookies(host_key TEXT, name TEXT, path TEXT, encrypted_value BLOB)');
    db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?)').run('example.com', 'a', '/', Buffer.from('v10x'));
    db.close();

    const [row] = await readChromeCookieRows(chromeCookiePath(root, 'Old'), ['example.com']);

    expect(row.expiresUtc).toBe(0n);
    expect(row.sameSite).toBe(-1);
    expect(row.isSecure).toBe(false);
  });

  it('leaves the original database alone', async () => {
    const path = chromeCookiePath(root, 'Default');
    await readChromeCookieRows(path, ['example.com']);

    const db = new DatabaseSync(path);
    const [{ n }] = db.prepare('SELECT COUNT(*) AS n FROM cookies').all() as { n: number }[];
    db.close();
    expect(n).toBe(5);
  });
});
