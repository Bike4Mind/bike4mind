import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSession } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { ImportScopeChangedError, SessionStore } from './SessionStore';
import { sessionScopeKey, type SessionScope } from './sessionScope';

function imported(id: string, title: string): ChatSession {
  const at = '2026-01-01T00:00:00.000Z';
  return {
    id,
    title,
    model: 'm',
    createdAt: at,
    updatedAt: at,
    mode: 'chat',
    approvalMode: 'ask',
    reasoningEffort: 'default',
    importOrigin: { kind: 'claude-chat', sourceId: id, importedAt: at, sourceUpdatedAt: at },
    messages: [{ id: `cl-${id}-1`, role: 'user', content: 'hello', createdAt: at }],
  };
}

describe('SessionStore imports', () => {
  it('writes, replaces, and keeps the user row choices across a re-sync', async () => {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'store-import-')), 'default');
    expect(await store.putImported(imported('cl-a', 'First'))).toBe('written');
    await store.setPinned('cl-a', true);
    await store.rename('cl-a', 'My name');
    expect(await store.putImported({ ...imported('cl-a', 'Upstream name'), messages: [] })).toBe('written');
    const session = (await store.get('cl-a'))!;
    expect(session).toMatchObject({ title: 'My name', pinned: true, messages: [] });
    expect(session.importOrigin).toMatchObject({ kind: 'claude-chat', sourceId: 'cl-a' });
  });

  it('marks a session forked on the first desktop message, and refuses to overwrite it after', async () => {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'store-import-')), 'default');
    await store.putImported(imported('cl-b', 'Imported'));
    await store.appendMessage('cl-b', { id: 'cl-b-2', role: 'user', content: 'still imported', createdAt: 'x' });
    expect((await store.get('cl-b'))!.importOrigin!.forkedAt).toBeUndefined();
    await store.appendMessage('cl-b', { id: 'desktop', role: 'user', content: 'mine', createdAt: 'x' });
    expect((await store.get('cl-b'))!.importOrigin!.forkedAt).toBeTruthy();

    expect(await store.putImported(imported('cl-b', 'Overwrite attempt'))).toBe('forked');
    expect((await store.get('cl-b'))!.messages.at(-1)!.content).toBe('mine');
  });

  it('never replaces a session that was not imported', async () => {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'store-import-')), 'default');
    const own = await store.create();
    expect(await store.putImported(imported(own.id, 'Collision'))).toBe('forked');
    expect((await store.get(own.id))!.importOrigin).toBeUndefined();
  });

  it('lists from the summary index without re-reading files whose size and mtime are unchanged', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'store-index-'));
    const store = new SessionStore(directory, 'default');
    await store.putImported(imported('cl-c', 'Original'));
    const path = join(directory, 'cl-c.json');
    const fixed = new Date('2026-01-01T00:00:00.000Z');
    await utimes(path, fixed, fixed);
    expect((await store.list()).map(session => session.title)).toEqual(['Original']);

    // Same length, same mtime: the index answers and the edit is not seen.
    await writeFile(path, (await readFile(path, 'utf8')).replace('Original', 'Replaced'));
    await utimes(path, fixed, fixed);
    const fresh = new SessionStore(directory, 'default');
    expect((await fresh.list()).map(session => session.title)).toEqual(['Original']);

    // A real write changes the mtime, so it is re-read.
    await fresh.rename('cl-c', 'Renamed');
    expect((await fresh.list()).map(session => session.title)).toEqual(['Renamed']);

    // A deleted file drops out of the listing and the index.
    await fresh.delete('cl-c');
    expect(await fresh.list()).toEqual([]);
  });

  it('ignores an index built under different launch defaults', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'store-index-'));
    const first = new SessionStore(directory, 'model-one');
    const created = await first.create();
    await writeFile(
      join(directory, `${created.id}.json`),
      JSON.stringify({ ...(await first.get(created.id)), model: '' })
    );
    expect((await first.list())[0].model).toBe('model-one');
    const second = new SessionStore(directory, 'model-two');
    expect((await second.list())[0].model).toBe('model-two');
  });

  it('refuses an import whose account is no longer the one signed in', async () => {
    const alice: SessionScope = { environmentUrl: 'http://localhost:3000', accountId: 'account-alice' };
    const bob: SessionScope = { environmentUrl: 'http://localhost:3000', accountId: 'account-bob' };
    let current: SessionScope | null = alice;
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'store-import-')), 'default', 'launch', () => current);
    const started = sessionScopeKey(alice);
    expect(await store.putImported(imported('cl-d', 'Hers'), started)).toBe('written');

    current = bob;
    await expect(store.putImported(imported('cl-e', 'Also hers'), started)).rejects.toBeInstanceOf(
      ImportScopeChangedError
    );
    await expect(store.getImported('cl-d', started)).rejects.toBeInstanceOf(ImportScopeChangedError);
    expect(await store.list()).toEqual([]);
    current = null;
    await expect(store.putImported(imported('cl-e', 'Also hers'), started)).rejects.toBeInstanceOf(
      ImportScopeChangedError
    );
    current = alice;
    expect((await store.list()).map(session => session.id)).toEqual(['cl-d']);
  });

  it('keeps what the user set on an imported session that the import does not', async () => {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'store-import-')), 'default');
    await store.putImported(imported('cl-f', 'First'));
    await store.addGrantedDirectory('cl-f', '/work/granted');
    await store.putImported({ ...imported('cl-f', 'Second'), messages: [] });
    expect((await store.get('cl-f'))!).toMatchObject({ title: 'Second', grantedDirectories: ['/work/granted'] });
  });
  it('does not recreate a copy deleted after the importer read it', async () => {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'store-import-')), 'default');
    await store.putImported(imported('cl-race', 'Original'));
    const snapshot = (await store.getImported('cl-race'))!;
    await store.delete('cl-race');
    expect(await store.putImported(snapshot, undefined, { mustExist: true })).toBe('removed');
    expect(await store.get('cl-race')).toBeNull();
  });

  it('checks continuation inside the guarded removal instead of trusting an earlier summary', async () => {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'store-import-')), 'default');
    await store.putImported(imported('cl-remove', 'Original'));
    const snapshot = (await store.list())[0];
    expect(snapshot.importOrigin?.forkedAt).toBeUndefined();
    await store.appendMessage('cl-remove', { id: 'desktop-turn', role: 'user', content: 'keep me', createdAt: 'x' });
    expect(await store.deleteImported('cl-remove', 'unused-unscoped-key')).toBe('forked');
    expect((await store.get('cl-remove'))?.messages.at(-1)?.content).toBe('keep me');
    expect(await store.deleteImported('missing', 'unused-unscoped-key')).toBe('missing');
    await store.putImported(imported('cl-uncontinued', 'Original'));
    expect(await store.deleteImported('cl-uncontinued', 'unused-unscoped-key')).toBe('removed');
    expect(await store.get('cl-uncontinued')).toBeNull();
  });

  it('refuses guarded removal after the account has changed', async () => {
    const alice: SessionScope = { environmentUrl: 'http://localhost:3000', accountId: 'account-alice' };
    const bob: SessionScope = { environmentUrl: 'http://localhost:3000', accountId: 'account-bob' };
    let current: SessionScope = alice;
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'store-import-')), 'default', 'launch', () => current);
    const aliceKey = sessionScopeKey(alice);
    await store.putImported(imported('cl-shared', 'Alice'), aliceKey);
    current = bob;
    await store.putImported(imported('cl-shared', 'Bob'), sessionScopeKey(bob));
    await expect(store.deleteImported('cl-shared', aliceKey)).rejects.toBeInstanceOf(ImportScopeChangedError);
    expect((await store.get('cl-shared'))?.title).toBe('Bob');
    current = alice;
    expect((await store.get('cl-shared'))?.title).toBe('Alice');
  });

});
