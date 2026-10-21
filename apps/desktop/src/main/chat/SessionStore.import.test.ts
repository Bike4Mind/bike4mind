import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSession } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { SessionStore } from './SessionStore';

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
});
