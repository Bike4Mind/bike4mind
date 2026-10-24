import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChatSession } from '@shared/chat';
import { LocalHistory } from './LocalHistory';

const session = (enabled: boolean): ChatSession => ({
  id: 's',
  title: 'Offline notes',
  model: 'm',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  mode: 'chat',
  approvalMode: 'ask',
  reasoningEffort: 'default',
  historyEnabled: enabled,
  messages: [{ id: 'u', role: 'user', content: 'Find the moon password=secret-value', createdAt: 'x' }],
});

describe('LocalHistory', () => {
  it('is opt-in, captures typed pages, redacts secrets, searches offline, and clears all rows', async () => {
    const history = new LocalHistory(join(await mkdtemp(join(tmpdir(), 'b4m-history-')), 'history.sqlite'));
    history.captureSession(session(false));
    expect(history.state()).toEqual({ entries: 0 });
    history.captureSession(session(true));
    history.capturePage('s', {
      url: 'https://example.com/page?token=secret',
      title: 'Example',
      capturedAt: '2026-01-01T00:00:00.000Z',
      blocks: [{ id: 'b1', kind: 'text', text: 'Typed page content' }],
      actions: [],
      claims: [],
      truncated: false,
    });
    expect(history.search('moon')[0]).toMatchObject({ kind: 'session', sessionId: 's' });
    expect(JSON.stringify(history.search('secret-value'))).not.toContain('secret-value');
    expect(history.search('Typed page')[0]).toMatchObject({ kind: 'page', url: 'https://example.com/page' });
    expect(history.clear()).toEqual({ entries: 0 });
    expect(history.search('moon')).toEqual([]);
    history.close();
  });

  it('never reveals one account scope to another', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'b4m-history-scope-')), 'history.sqlite');
    let scope = 'account-a';
    const history = new LocalHistory(path, () => scope);
    history.captureSession({
      ...session(true),
      title: 'Private alpha',
      messages: [{ id: 'a', role: 'user', content: 'private alpha material', createdAt: 'x' }],
    });
    scope = 'account-b';
    history.captureSession({
      ...session(true),
      title: 'Account B notes',
      messages: [{ id: 'b', role: 'user', content: 'public beta material', createdAt: 'x' }],
    });
    expect(history.search('private alpha')).toEqual([]);
    expect(history.search('Account B')).toHaveLength(1);
    expect(history.state()).toEqual({ entries: 1 });
    history.close();
  });

  it('clears and removes only the current scope, and redacts titles', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'b4m-history-clear-')), 'history.sqlite');
    let scope = 'account-a';
    const history = new LocalHistory(path, () => scope);
    history.captureSession({ ...session(true), title: 'deploy api_key=sk_live_ABCDEF1234567890' });
    expect(JSON.stringify(history.search('deploy'))).not.toContain('sk_live_ABCDEF1234567890');
    scope = 'account-b';
    history.captureSession({ ...session(true), id: 'other' });
    history.captureSession({ ...session(true), id: 'keep' });
    history.removeSession('other');
    expect(history.state()).toEqual({ entries: 1 });
    expect(history.clear()).toEqual({ entries: 0 });
    scope = 'account-a';
    expect(history.state()).toEqual({ entries: 1 });
    history.close();
  });

  it('is not open to a database written by a newer version', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'b4m-history-newer-')), 'history.sqlite');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 99');
    db.close();
    expect(() => new LocalHistory(path)).toThrow('newer Bike4Mind version');
  });
  it('uses semantic fallback without duplicating lexical hits, and stays scoped while signed out', () => {
    let scope: string | null = 'account-a';
    const history = new LocalHistory(':memory:', () => scope);
    history.captureSession({
      ...session(true),
      id: 'partial',
      title: 'Notes',
      messages: [{ id: 'u', role: 'user', content: 'moon expedition', createdAt: 'x' }],
    });
    history.captureSession({
      ...session(true),
      id: 'exact',
      title: 'Notes',
      messages: [{ id: 'u', role: 'user', content: 'moon expedition launch', createdAt: 'x' }],
    });
    const results = history.search('moon launch');
    expect(results.map(result => result.sessionId)).toEqual(['exact', 'partial']);
    expect(history.search('moon launch', 1).map(result => result.sessionId)).toEqual(['exact']);
    scope = 'account-b';
    expect(history.search('moon launch')).toEqual([]);
    scope = null;
    expect(history.search('moon launch')).toEqual([]);
    expect(history.state()).toEqual({ entries: 0 });
    expect(history.clear()).toEqual({ entries: 0 });
    history.removeSession('exact');
    scope = 'account-a';
    expect(history.state()).toEqual({ entries: 2 });
    history.close();
  });

  it('returns no results for blank queries and consistently caps lexical plus fallback results', () => {
    const history = new LocalHistory(':memory:');
    for (let index = 0; index < 110; index += 1) {
      history.captureSession({ ...session(true), id: String(index) });
    }
    expect(history.search('   ')).toEqual([]);
    expect(history.search('moon', 200)).toHaveLength(100);
    expect(history.search('moon launch', 200)).toHaveLength(100);
    expect(history.search('moon', Number.NaN)).toHaveLength(30);
    history.close();
  });

  it.each([1, 2])('keeps legacy v%i rows inaccessible instead of guessing their account owner', version => {
    const path = join(tmpdir(), `b4m-history-legacy-${version}-${crypto.randomUUID()}.sqlite`);
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE entries(id TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT NOT NULL,
      title TEXT NOT NULL, url TEXT NOT NULL, content TEXT NOT NULL, captured_at TEXT NOT NULL
      ${version === 2 ? ", embedding TEXT NOT NULL DEFAULT '[]'" : ''});
      INSERT INTO entries(id, kind, session_id, title, url, content, captured_at)
      VALUES ('session:s', 'session', 's', 'Legacy', '', 'private moon material', '2026-01-01');
      PRAGMA user_version = ${version};`);
    database.close();
    let scope: string | null = 'account-b';
    const history = new LocalHistory(path, () => scope);
    expect(history.state()).toEqual({ entries: 0 });
    expect(history.search('moon')).toEqual([]);
    scope = null;
    expect(history.state()).toEqual({ entries: 0 });
    expect(history.search('moon')).toEqual([]);
    scope = 'account-b';
    history.captureSession(session(true));
    expect(history.search('moon')).toHaveLength(1);
    history.close();
    const migrated = new DatabaseSync(path);
    expect(migrated.prepare("SELECT scope FROM entries WHERE id = 'session:s'").get()?.scope).toBe('');
    expect(migrated.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
    migrated.close();
  });

  it('rolls back every schema change when a legacy migration fails, so a retry can succeed', () => {
    const path = join(tmpdir(), `b4m-history-rollback-${crypto.randomUUID()}.sqlite`);
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE entries(id TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT NOT NULL,
      title TEXT NOT NULL, url TEXT NOT NULL, content TEXT NOT NULL, captured_at TEXT NOT NULL);
      INSERT INTO entries VALUES ('session:s', 'session', 's', 'Legacy', '', 'moon', '2026-01-01');
      CREATE TRIGGER fail_update BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT, 'migration failed'); END;
      PRAGMA user_version = 1;`);
    database.close();
    expect(() => new LocalHistory(path)).toThrow('migration failed');
    const failed = new DatabaseSync(path);
    expect(failed.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    expect(
      failed
        .prepare('PRAGMA table_info(entries)')
        .all()
        .map(column => column.name)
    ).not.toContain('embedding');
    failed.exec('DROP TRIGGER fail_update');
    failed.close();
    const retried = new LocalHistory(path);
    expect(retried.state()).toEqual({ entries: 0 });
    retried.close();
  });
  it('replaces snapshots at the sanitized page URL per session and removes all of a deleted session', () => {
    const history = new LocalHistory(':memory:');
    const page = {
      url: 'https://user:password@example.com/page?token=private#secret',
      title: 'Example',
      capturedAt: '2026-01-01T00:00:00.000Z',
      blocks: [{ id: 'b1', kind: 'text' as const, text: 'older snapshot' }],
      actions: [],
      claims: [],
      truncated: false,
    };
    history.capturePage('first', page);
    history.capturePage('first', {
      ...page,
      url: 'https://example.com/page?token=changed#second',
      blocks: [{ id: 'b1', kind: 'text', text: 'newer snapshot' }],
    });
    history.capturePage('second', page);
    history.captureSession({ ...session(true), id: 'first' });
    expect(history.state()).toEqual({ entries: 3 });
    expect(history.search('newer')[0]).toMatchObject({ sessionId: 'first', url: 'https://example.com/page' });
    expect(history.search('older').some(result => result.sessionId === 'first')).toBe(false);
    history.removeSession('first');
    expect(history.state()).toEqual({ entries: 1 });
    expect(history.search('older')[0]).toMatchObject({ sessionId: 'second' });
    history.close();
  });
  it('rejects stale captures and deletes only the captured namespace after an account changes', () => {
    let scope = 'account-a';
    const history = new LocalHistory(':memory:', () => scope);
    const expected = history.scopeKey();
    history.captureSession(session(true), expected);
    scope = 'account-b';
    history.captureSession(session(true), history.scopeKey());
    history.captureSession({ ...session(true), title: 'private alpha' }, expected);
    history.removeSession('s', expected);
    expect(history.state()).toEqual({ entries: 1 });
    expect(history.search('private alpha')).toEqual([]);
    scope = 'account-a';
    expect(history.state()).toEqual({ entries: 0 });
    history.close();
  });
  it('notifies search subscribers after captures, removals and clears', () => {
    const changed = vi.fn();
    const history = new LocalHistory(':memory:', () => 'account-a', changed);
    try {
      history.captureSession(session(false));
      expect(changed).not.toHaveBeenCalled();
      history.captureSession(session(true));
      expect(changed).toHaveBeenCalledTimes(1);
      history.capturePage('s', {
        url: 'https://example.com/page',
        title: 'A page',
        capturedAt: '2026-01-01T00:00:00.000Z',
        blocks: [{ id: 'b', kind: 'text', text: 'searchable page' }],
        actions: [],
        claims: [],
        truncated: false,
      });
      expect(changed).toHaveBeenCalledTimes(2);
      history.removeSession('s');
      expect(changed).toHaveBeenCalledTimes(3);
      history.clear();
      expect(changed).toHaveBeenCalledTimes(4);
    } finally {
      history.close();
    }
  });
});
