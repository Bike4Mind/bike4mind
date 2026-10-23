import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
});
