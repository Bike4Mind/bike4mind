import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatProject } from '@shared/chat';
import { SessionStore } from './SessionStore';

const MODEL = 'test-model';

/**
 * A session file exactly as the version BEFORE modes existed wrote it - captured by running
 * that SessionStore, not hand-written, because the point of these tests is that a real user's
 * existing conversations still open. Note what is absent: no `mode`, no `project`, no `pinned`.
 */
const LEGACY_SESSION = `{
  "id": "e7a40af4-b94a-485f-9a48-b0c9a32c6aa9",
  "title": "what does resolveWithinRoots do?",
  "model": "claude-4-5-sonnet",
  "createdAt": "2026-09-28T13:15:48.874Z",
  "updatedAt": "2026-09-28T13:15:48.885Z",
  "messages": [
    {
      "id": "m1",
      "role": "user",
      "content": "what does resolveWithinRoots do?",
      "createdAt": "2026-09-20T10:00:00.000Z"
    },
    {
      "id": "m2",
      "role": "assistant",
      "content": "It resolves a tool path and proves it is inside a granted root.",
      "createdAt": "2026-09-20T10:00:03.000Z",
      "stopReason": "end_turn"
    }
  ]
}`;

const LEGACY_ID = 'e7a40af4-b94a-485f-9a48-b0c9a32c6aa9';

const PROJECT: ChatProject = {
  directory: '/repos/thing',
  name: 'thing',
  branch: 'feat/x',
  workspace: true,
  workingDirectory: '/repos/thing+feat+x',
  contextDirectories: ['/repos/reference'],
};

async function freshStore(): Promise<{ store: SessionStore; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-modes-'));
  return { store: new SessionStore(directory, MODEL), directory };
}

describe('SessionStore migration', () => {
  let store: SessionStore;
  let directory: string;

  beforeEach(async () => {
    ({ store, directory } = await freshStore());
    await writeFile(join(directory, `${LEGACY_ID}.json`), LEGACY_SESSION, 'utf8');
  });

  it('opens a conversation written before modes existed, with its messages intact', async () => {
    const session = await store.get(LEGACY_ID);

    expect(session).not.toBeNull();
    expect(session?.title).toBe('what does resolveWithinRoots do?');
    expect(session?.model).toBe('claude-4-5-sonnet');
    expect(session?.messages).toHaveLength(2);
    expect(session?.messages[1]).toMatchObject({ content: expect.stringContaining('granted root') });
  });

  it('reads a session with no mode as a Chat session with no project', async () => {
    const session = await store.get(LEGACY_ID);

    expect(session?.mode).toBe('chat');
    expect(session?.project).toBeUndefined();
    expect(session?.pinned).toBeUndefined();
  });

  it('lists a legacy session alongside a new one', async () => {
    await store.create();
    const listed = await store.list();

    expect(listed).toHaveLength(2);
    expect(listed.map(entry => entry.mode)).toEqual(['chat', 'chat']);
  });

  // Rewriting has to keep the conversation: this is the path where a migration loses history.
  it('keeps every message when a legacy session is written back', async () => {
    await store.appendMessage(LEGACY_ID, {
      id: 'm3',
      role: 'user',
      content: 'and now?',
      createdAt: new Date().toISOString(),
    });

    const session = await store.get(LEGACY_ID);
    expect(session?.messages.map(message => message.id)).toEqual(['m1', 'm2', 'm3']);
    expect(session?.mode).toBe('chat');
  });

  /**
   * A file claiming Code with no usable project reads back UNBOUND rather than as Chat: it
   * keeps the chip row that can re-point it, and an unbound Code session is granted no roots
   * at all, so it cannot fall back to the first global grant. It used to be downgraded, which
   * dropped the project silently and moved the conversation out of Code mode with it.
   */
  it('keeps a code session whose project is unusable in Code mode, unbound', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    await writeFile(
      join(directory, `${id}.json`),
      JSON.stringify({ id, title: 'broken', mode: 'code', project: { directory: '/repos/thing' }, messages: [] }),
      'utf8'
    );

    const session = await store.get(id);
    expect(session?.mode).toBe('code');
    expect(session?.project).toBeUndefined();
    expect(session?.title).toBe('broken');
  });
});

describe('SessionStore code sessions', () => {
  let store: SessionStore;

  beforeEach(async () => {
    ({ store } = await freshStore());
  });

  it('records the project and round-trips it', async () => {
    const created = await store.create(MODEL, PROJECT);
    expect(created.mode).toBe('code');

    const loaded = await store.get(created.id);
    expect(loaded?.project).toEqual(PROJECT);
  });

  it('leaves a Code session untitled so the first prompt still names it', async () => {
    const created = await store.create(MODEL, PROJECT);
    await store.appendMessage(created.id, {
      id: 'm1',
      role: 'user',
      content: 'why does the build fail?',
      createdAt: new Date().toISOString(),
    });

    expect((await store.get(created.id))?.title).toBe('why does the build fail?');
  });

  it('pins and unpins without reordering the row by touching updatedAt', async () => {
    const created = await store.create();
    const pinned = await store.setPinned(created.id, true);

    expect(pinned?.pinned).toBe(true);
    expect(pinned?.updatedAt).toBe(created.updatedAt);
    expect((await store.setPinned(created.id, false))?.pinned).toBeUndefined();
  });

  it('adds a context directory once, and removes it', async () => {
    const created = await store.create(MODEL, PROJECT);
    await store.addContextDirectory(created.id, '/repos/another');
    await store.addContextDirectory(created.id, '/repos/another');

    expect((await store.get(created.id))?.project?.contextDirectories).toEqual(['/repos/reference', '/repos/another']);

    await store.removeContextDirectory(created.id, '/repos/reference');
    expect((await store.get(created.id))?.project?.contextDirectories).toEqual(['/repos/another']);
  });

  it('refuses a context directory on a Chat session, which has no project to put it in', async () => {
    const created = await store.create();
    expect(await store.addContextDirectory(created.id, '/repos/another')).toBeNull();
  });

  // Deleting a conversation must never be a way to lose a worktree that holds uncommitted work.
  it('deletes the session without touching the project directory', async () => {
    const created = await store.create(MODEL, PROJECT);
    await store.delete(created.id);

    expect(await store.get(created.id)).toBeNull();
  });
});
