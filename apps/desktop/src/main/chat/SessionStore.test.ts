import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { deriveTitle, SessionStore } from './SessionStore';

const MODEL = 'test-model';

async function freshStore(): Promise<{ store: SessionStore; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-sessions-'));
  return { store: new SessionStore(directory, MODEL), directory };
}

describe('deriveTitle', () => {
  it('collapses whitespace so a pasted multi-line prompt stays one sidebar row', () => {
    expect(deriveTitle('  what is\n\n  a monad?  ')).toBe('what is a monad?');
  });

  it('falls back to the placeholder for a blank prompt', () => {
    expect(deriveTitle('   \n ')).toBe('New chat');
  });

  it('ellipsizes a long prompt without exceeding the budget', () => {
    const title = deriveTitle('x'.repeat(200));
    expect(title).toHaveLength(60);
    expect(title.endsWith('...')).toBe(true);
  });
});

describe('SessionStore', () => {
  let store: SessionStore;
  let directory: string;

  beforeEach(async () => {
    ({ store, directory } = await freshStore());
  });

  it('creates an untitled session carrying the default model', async () => {
    const created = await store.create();
    expect(created).toMatchObject({ title: 'New chat', model: MODEL, messageCount: 0 });

    const loaded = await store.get(created.id);
    expect(loaded?.messages).toEqual([]);
    expect(loaded?.historyEnabled).toBeUndefined();
  });

  it('persists per-session local history consent', async () => {
    const created = await store.create();
    await store.setHistoryEnabled(created.id, true);
    expect((await new SessionStore(directory, MODEL).get(created.id))?.historyEnabled).toBe(true);
  });

  it('keeps a title given at creation over the first prompt, in one write', async () => {
    const { id } = await store.create(MODEL, { title: 'Tidy imports' });
    await store.appendMessage(id, {
      id: 'm1',
      role: 'user',
      content: 'seed text',
      createdAt: new Date().toISOString(),
    });

    expect((await store.get(id))?.title).toBe('Tidy imports');
  });

  it("keeps a session's write record beside it, out of the listing, until it is removed", async () => {
    const created = await store.create();
    const writes = { files: [['/repo/a.sh', 1]], trees: [], hooks: [], overflowed: false } satisfies Parameters<
      SessionStore['saveSessionWrites']
    >[1];
    expect(await store.loadSessionWrites(created.id)).toBeNull();
    await store.saveSessionWrites(created.id, writes);

    const relaunched = new SessionStore(directory, MODEL);
    expect(await relaunched.loadSessionWrites(created.id)).toEqual(writes);
    expect((await relaunched.list()).map(session => session.id)).toEqual([created.id]);

    await relaunched.deleteSessionWrites(created.id);
    expect(await relaunched.loadSessionWrites(created.id)).toBeNull();
    await expect(store.saveSessionWrites('../escape', writes)).rejects.toThrow('invalid session id');
  });

  it('returns null for a session that does not exist rather than throwing', async () => {
    expect(await store.get('deadbeef')).toBeNull();
  });

  // The renderer hands ids back over IPC, so the sink has to reject a traversal itself.
  it.each(['../auth-vault', 'a/b', '..'])('refuses the path-escaping id %j', async id => {
    await expect(store.get(id)).rejects.toThrow(/invalid session id/);
  });

  it('titles the session from the first user prompt only', async () => {
    const { id } = await store.create();
    await store.appendMessage(id, {
      id: 'm1',
      role: 'user',
      content: 'first thing',
      createdAt: new Date().toISOString(),
    });
    await store.appendMessage(id, {
      id: 'm2',
      role: 'user',
      content: 'second thing',
      createdAt: new Date().toISOString(),
    });

    expect((await store.get(id))?.title).toBe('first thing');
  });

  it('replaces the provisional truncation with a generated title', async () => {
    const { id } = await store.create();
    await store.appendMessage(id, {
      id: 'm1',
      role: 'user',
      content: 'In my shared folder, read alpha.txt and tell me what it says',
      createdAt: new Date().toISOString(),
    });

    const summary = await store.applyGeneratedTitle(id, 'Reading alpha.txt');

    expect(summary?.title).toBe('Reading alpha.txt');
    expect((await store.get(id))?.title).toBe('Reading alpha.txt');
  });

  // The race the feature turns on: generation is in flight while the user renames the row.
  it('refuses a generated title once the user has named the session', async () => {
    const { id } = await store.create();
    await store.rename(id, 'My own name');

    expect(await store.applyGeneratedTitle(id, 'Something The Model Chose')).toBeNull();
    expect((await store.get(id))?.title).toBe('My own name');
  });

  it('keeps the lock across a reload, so a later run cannot rename it either', async () => {
    const { id } = await store.create();
    await store.rename(id, 'My own name');

    const reopened = new SessionStore(directory, MODEL);
    expect(await reopened.applyGeneratedTitle(id, 'Something The Model Chose')).toBeNull();
  });

  // Leaves updatedAt alone, as pinning does: naming a row says nothing about when it was
  // last talked to, and bumping it would reorder the sidebar behind the user's back.
  it('does not reorder the sidebar when a title lands', async () => {
    const { id, updatedAt } = await store.create();
    await store.applyGeneratedTitle(id, 'A generated name');

    expect((await store.get(id))?.updatedAt).toBe(updatedAt);
  });

  it('settles a streamed reply in place via updateMessage', async () => {
    const { id } = await store.create();
    await store.appendMessage(id, { id: 'r1', role: 'assistant', content: '', createdAt: new Date().toISOString() });
    await store.updateMessage(id, 'r1', { content: 'done', stopReason: 'end_turn' });

    const message = (await store.get(id))?.messages[0];
    expect(message).toMatchObject({ content: 'done', stopReason: 'end_turn' });
  });

  it('lists newest first', async () => {
    const older = await store.create();
    const newer = await store.create();
    // updatedAt is an ISO string at whole-millisecond resolution, so two creates in the same
    // tick would otherwise tie and make the assertion depend on readdir order. The rename is
    // held back a tick for the same reason: on a warm process it lands in the creates' own
    // millisecond and the tie comes straight back.
    await new Promise(resolve => setTimeout(resolve, 2));
    await store.rename(newer.id, 'touched later');

    const listed = await store.list();
    expect(listed.map(session => session.id)).toEqual([newer.id, older.id]);
  });

  it('skips an unparseable file instead of failing the whole list', async () => {
    const { id } = await store.create();
    await writeFile(join(directory, 'corrupt.json'), '{ not json', 'utf8');

    expect((await store.list()).map(session => session.id)).toEqual([id]);
  });

  it('leaves no temp file behind, so a crashed write cannot masquerade as a session', async () => {
    await store.create();
    expect((await readdir(directory)).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('deletes without complaining about an already-gone session', async () => {
    const { id } = await store.create();
    await store.delete(id);
    await expect(store.delete(id)).resolves.toBeUndefined();
    expect(await store.get(id)).toBeNull();
  });
  describe('updateProjectWorkspace', () => {
    const project = {
      directory: '/repo',
      name: 'repo',
      branch: 'main',
      workspace: true,
      workingDirectory: '/repo',
      contextDirectories: ['/notes'],
    };

    it('changes where the session runs and keeps the folders and branch stored now', async () => {
      const { id } = await store.create(undefined, { project: { ...project, workspaceBranch: 'b4m/one' } });
      await store.addContextDirectory(id, '/more');

      await store.updateProjectWorkspace(id, { workingDirectory: '/repo-wt' });

      expect((await store.get(id))?.project).toMatchObject({
        workingDirectory: '/repo-wt',
        workspaceBranch: 'b4m/one',
        contextDirectories: ['/notes', '/more'],
      });
    });

    it('leaves a Chat session without a project alone', async () => {
      const { id } = await store.create();

      expect(await store.updateProjectWorkspace(id, { workingDirectory: '/repo-wt' })).toBeNull();
      expect((await store.get(id))?.project).toBeUndefined();
    });
  });

  describe('summary fields for the orchestrator roster', () => {
    const at = '2026-01-01T00:00:00.000Z';

    it('carries the last outcome, snippet and summed cost', async () => {
      const { id } = await store.create();
      await store.appendMessage(id, { id: 'u1', role: 'user', content: 'fix it', createdAt: at });
      await store.appendMessage(id, {
        id: 'a1',
        role: 'assistant',
        content: 'Fixed the bug in foo.ts',
        createdAt: at,
        usage: { usdCost: 0.25, creditsUsed: 10 },
      });
      await store.appendMessage(id, {
        id: 'a2',
        role: 'assistant',
        content: '',
        createdAt: at,
        usage: { usdCost: 0.5 },
      });

      const [summary] = await store.list();
      expect(summary).toMatchObject({ lastOutcome: 'finished', totalUsdCost: 0.75, totalCredits: 10 });
      expect(summary.lastSnippet).toBeUndefined();

      await store.appendMessage(id, { id: 'a3', role: 'assistant', content: 'All\n  done', createdAt: at });
      expect((await store.list())[0].lastSnippet).toBe('All done');
    });

    it('leaves all four fields off a session with only a user message', async () => {
      const { id } = await store.create();
      await store.appendMessage(id, { id: 'u1', role: 'user', content: 'hello', createdAt: at });

      const [summary] = await store.list();
      expect(summary).not.toHaveProperty('lastOutcome');
      expect(summary).not.toHaveProperty('lastSnippet');
      expect(summary).not.toHaveProperty('totalUsdCost');
      expect(summary).not.toHaveProperty('totalCredits');
    });

    it('recomputes summaries cached by an older index version', async () => {
      const { id } = await store.create();
      await store.appendMessage(id, { id: 'a1', role: 'assistant', content: 'hi', createdAt: at });
      await store.list();

      const indexPath = join(directory, '.summary-index');
      const index = JSON.parse(await readFile(indexPath, 'utf8'));
      index.version = 1;
      delete index.entries[id].summary.lastOutcome;
      delete index.entries[id].summary.lastSnippet;
      await writeFile(indexPath, JSON.stringify(index), 'utf8');

      const [summary] = await new SessionStore(directory, MODEL).list();
      expect(summary).toMatchObject({ lastOutcome: 'finished', lastSnippet: 'hi' });
    });
  });
});
