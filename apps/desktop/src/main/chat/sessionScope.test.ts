import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthState } from '@shared/auth';
import { assertScopeKey, migrateLegacySessions, sessionScopeFor, sessionScopeKey } from './sessionScope';

const ACCOUNT = '66b1f0c2a4e1d20012ab34cd';

function signedIn(url: string, accountId: string): AuthState {
  return {
    status: 'signed-in',
    environment: { preset: 'local', url, label: 'Local Dev' },
    hostedAvailable: true,
    storage: 'available',
    busy: 'idle',
    user: { id: accountId },
  };
}

describe('sessionScopeKey', () => {
  it('separates two accounts on one backend', () => {
    const a = sessionScopeKey({ environmentUrl: 'http://localhost:3000', accountId: 'account-a' });
    const b = sessionScopeKey({ environmentUrl: 'http://localhost:3000', accountId: 'account-b' });
    expect(a).not.toBe(b);
  });

  it('separates two backends for one account', () => {
    const local = sessionScopeKey({ environmentUrl: 'http://localhost:3000', accountId: ACCOUNT });
    const hosted = sessionScopeKey({ environmentUrl: 'https://app.bike4mind.com', accountId: ACCOUNT });
    expect(local).not.toBe(hosted);
  });

  it('names the folder after the endpoint so the sessions directory stays readable', () => {
    expect(sessionScopeKey({ environmentUrl: 'http://localhost:3000', accountId: ACCOUNT })).toMatch(
      /^localhost-3000-[0-9a-f]{12}$/
    );
  });

  it('holds one backend to one folder across the spellings that mean the same thing', () => {
    const canonical = sessionScopeKey({ environmentUrl: 'https://app.bike4mind.com', accountId: ACCOUNT });
    for (const spelling of [
      'https://app.bike4mind.com/',
      'https://app.bike4mind.com///',
      'https://APP.Bike4Mind.com',
      'https://app.bike4mind.com:443',
    ]) {
      expect(sessionScopeKey({ environmentUrl: spelling, accountId: ACCOUNT })).toBe(canonical);
    }
  });

  // Documented consequence, not an accident: see canonicalEndpoint. Two strings for one backend
  // stay two folders, because telling them apart from two backends means asking the server.
  it('treats a differently-spelled host as a different backend', () => {
    const byName = sessionScopeKey({ environmentUrl: 'https://app.bike4mind.com', accountId: ACCOUNT });
    const byAlias = sessionScopeKey({ environmentUrl: 'https://www.app.bike4mind.com', accountId: ACCOUNT });
    expect(byName).not.toBe(byAlias);
  });

  it('keeps a hostile account id or URL out of the path it becomes', () => {
    const hostile = [
      { environmentUrl: 'http://localhost:3000', accountId: '../auth-vault' },
      { environmentUrl: 'http://localhost:3000', accountId: '../../../../etc/passwd' },
      { environmentUrl: 'http://../../auth-vault', accountId: ACCOUNT },
      { environmentUrl: 'http://localhost:3000', accountId: '..' },
      { environmentUrl: 'http://localhost:3000', accountId: 'a/b\\c' },
      { environmentUrl: 'not a url at all/../..', accountId: ACCOUNT },
      { environmentUrl: 'http://localhost:3000', accountId: 'e\u0301\u00e9\u4f60\u597d' },
      { environmentUrl: '', accountId: '' },
    ];

    const root = '/tmp/sessions';
    for (const scope of hostile) {
      const key = sessionScopeKey(scope);
      expect(key).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(key).not.toContain('.');
      expect(key).not.toContain(sep);
      expect(isAbsolute(key)).toBe(false);
      expect(resolve(join(root, key)).startsWith(`${root}${sep}`)).toBe(true);
    }
  });

  it('gives two hostile scopes that differ only after sanitising different folders', () => {
    const a = sessionScopeKey({ environmentUrl: 'http://localhost:3000', accountId: '../x' });
    const b = sessionScopeKey({ environmentUrl: 'http://localhost:3000', accountId: '..\\x' });
    expect(a).not.toBe(b);
  });
});

describe('assertScopeKey', () => {
  it('refuses anything that could be more than one path component', () => {
    for (const key of ['..', '.', 'a/b', 'a\\b', 'a.b', '/abs', '', 'UPPER', '-leading', 'x'.repeat(65)]) {
      expect(() => assertScopeKey(key)).toThrow(/invalid session scope key/);
    }
  });
});

describe('sessionScopeFor', () => {
  it('reads the endpoint and the account off the auth state', () => {
    expect(sessionScopeFor(signedIn('http://localhost:3000', ACCOUNT))).toEqual({
      environmentUrl: 'http://localhost:3000',
      accountId: ACCOUNT,
    });
  });

  it('has no scope with no account, rather than one everybody would share', () => {
    const state = signedIn('http://localhost:3000', ACCOUNT);
    expect(sessionScopeFor({ ...state, user: undefined })).toBeNull();
    expect(sessionScopeFor({ ...state, user: { id: '' } })).toBeNull();
    expect(sessionScopeFor(null)).toBeNull();
  });

  it('has no scope with no endpoint', () => {
    expect(sessionScopeFor(signedIn('', ACCOUNT))).toBeNull();
  });
});

describe('migrateLegacySessions', () => {
  async function legacyRoot(names: string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'b4m-migrate-'));
    for (const name of names) await writeFile(join(root, name), `{"id":"${name}"}`, 'utf8');
    return root;
  }

  it('moves every loose conversation into the scope, contents intact', async () => {
    const root = await legacyRoot(['one.json', 'two.json']);
    const destination = join(root, 'scope');
    await mkdir(destination, { recursive: true });

    expect((await migrateLegacySessions(root, destination)).sort()).toEqual(['one.json', 'two.json']);
    expect((await readdir(destination)).sort()).toEqual(['one.json', 'two.json']);
    expect(await readFile(join(destination, 'one.json'), 'utf8')).toBe('{"id":"one.json"}');
    expect((await readdir(root)).filter(name => name.endsWith('.json'))).toEqual([]);
  });

  it('leaves a half-written file where it is rather than promoting it into a scope', async () => {
    const root = await legacyRoot(['good.json', 'crashed.json.tmp']);
    const destination = join(root, 'scope');
    await mkdir(destination, { recursive: true });

    expect(await migrateLegacySessions(root, destination)).toEqual(['good.json']);
    expect(await readdir(root)).toContain('crashed.json.tmp');
  });

  it('runs once: the scope prepared next finds nothing left to take', async () => {
    const root = await legacyRoot(['one.json']);
    const first = join(root, 'first');
    const second = join(root, 'second');
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });

    expect(await migrateLegacySessions(root, first)).toEqual(['one.json']);
    expect(await migrateLegacySessions(root, second)).toEqual([]);
    expect(await readdir(second)).toEqual([]);
  });

  it('never writes over a transcript already in the destination', async () => {
    const root = await legacyRoot(['one.json']);
    const destination = join(root, 'scope');
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'one.json'), '{"id":"already here"}', 'utf8');

    expect(await migrateLegacySessions(root, destination)).toEqual([]);
    expect(await readFile(join(destination, 'one.json'), 'utf8')).toBe('{"id":"already here"}');
    // The file it declined to move is still where the user can find it.
    expect(await readFile(join(root, 'one.json'), 'utf8')).toBe('{"id":"one.json"}');
  });

  it('is a no-op on an install that has never stored a conversation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b4m-migrate-'));
    expect(await migrateLegacySessions(join(root, 'never-existed'), root)).toEqual([]);
  });
});
