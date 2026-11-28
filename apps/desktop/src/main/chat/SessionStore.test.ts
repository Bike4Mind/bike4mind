import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage, ChatProject, ChatReplyStats, ChatSpawnSuggestion } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentMayRetitle, deriveTitle, SessionStore } from './SessionStore';
import { STUDIO_BINDINGS_DIRECTORY } from './studio/StudioFamilyStore';
import { ApprovalModePreference } from './ApprovalModePreference';
import { PromptCacheTtlPreference } from './PromptCacheTtlPreference';
import { inheritancePolicy } from '@shared/orchestration';
import type { SessionScope } from './sessionScope';

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

  it('scans workspace owners past the Studio bindings folder a nested session writes', async () => {
    const parent = await store.create();
    await store.create(undefined, { origin: { parentSessionId: parent.id, depth: 1, seedPrompt: 'child' } });
    expect((await readdir(directory)).filter(name => name.startsWith('.'))).toContain(STUDIO_BINDINGS_DIRECTORY);
    await expect(store.workspaceOwnersExcept(parent.id)).resolves.toEqual(expect.any(Array));
  });

  it('persists per-session local history consent', async () => {
    const created = await store.create();
    await store.setHistoryEnabled(created.id, true);
    expect((await new SessionStore(directory, MODEL).get(created.id))?.historyEnabled).toBe(true);
  });

  it('reads after a write already queued for the session', async () => {
    const { id } = await store.create();
    const message = { id: 'm1', role: 'user', content: 'hello', createdAt: new Date().toISOString() } as const;
    const write = store.appendMessage(id, message);
    const read = store.getAfterWrites(id);
    await write;
    expect((await read)?.messages.map(stored => stored.id)).toEqual(['m1']);
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

  describe('setOrchestrate', () => {
    it('round-trips the flag through the file and the summary, and clears it rather than storing false', async () => {
      const { id } = await store.create();
      const before = (await store.get(id))?.updatedAt;

      expect(await store.setOrchestrate(id, true)).toMatchObject({ id, orchestrate: true });
      expect(await store.get(id)).toMatchObject({ orchestrate: true, updatedAt: before });
      expect((await store.list())[0]).toMatchObject({ id, orchestrate: true });

      expect(await store.setOrchestrate(id, false)).not.toHaveProperty('orchestrate');
      expect(JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8'))).not.toHaveProperty('orchestrate');
      expect((await store.list())[0]).not.toHaveProperty('orchestrate');
    });

    it('drops the flag on a relaunch, as full access is dropped, from the file and the cached summary', async () => {
      const { id } = await store.create();
      await store.setOrchestrate(id, true);
      // Caches the flagged summary in the index the next launch would read.
      expect((await store.list())[0]).toMatchObject({ orchestrate: true });

      const relaunched = new SessionStore(directory, MODEL, 'next-launch');
      expect(await relaunched.get(id)).not.toHaveProperty('orchestrate');
      expect((await relaunched.list())[0]).not.toHaveProperty('orchestrate');
      expect(await relaunched.setOrchestrate(id, true)).toMatchObject({ orchestrate: true });
      expect(await relaunched.get(id)).toMatchObject({ orchestrate: true });
    });

    it('reads a session and a cached summary written before the flag existed as not orchestrating', async () => {
      const { id } = await store.create();
      await store.list();

      const relaunched = new SessionStore(directory, MODEL);
      expect(await relaunched.get(id)).not.toHaveProperty('orchestrate');
      expect((await relaunched.list())[0]).not.toHaveProperty('orchestrate');
    });

    it('keeps the orchestrator mark across a relaunch, and clears it only when Orchestrate is turned off', async () => {
      const { id } = await store.create();
      expect(await store.setOrchestrate(id, true)).toMatchObject({ orchestrate: true, orchestrator: true });
      await store.list();

      const relaunched = new SessionStore(directory, MODEL, 'next-launch');
      expect(await relaunched.get(id)).toMatchObject({ orchestrator: true });
      expect(await relaunched.get(id)).not.toHaveProperty('orchestrate');
      expect((await relaunched.list())[0]).toMatchObject({ orchestrator: true });

      expect(await relaunched.setOrchestrate(id, false)).not.toHaveProperty('orchestrator');
      expect(JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8'))).not.toHaveProperty('orchestrator');
    });

    it('marks a session saved by an earlier launch with Orchestrate on, before the mark existed', async () => {
      const { id } = await store.create();
      const path = join(directory, `${id}.json`);
      const legacy = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      await writeFile(path, JSON.stringify({ ...legacy, orchestrate: true, orchestrateLaunch: 'old-launch' }), 'utf8');

      const relaunched = new SessionStore(directory, MODEL, 'next-launch');
      expect(await relaunched.get(id)).toMatchObject({ orchestrator: true });
      expect(await relaunched.get(id)).not.toHaveProperty('orchestrate');
    });

    it('returns null for a session that does not exist', async () => {
      expect(await store.setOrchestrate('00000000-0000-4000-8000-000000000000', true)).toBeNull();
    });
  });

  describe('reply stats', () => {
    const stats: ChatReplyStats = {
      totalMs: 5_000,
      modelMs: 4_800,
      toolMs: 0,
      firstTokenMs: 400,
      reasoningMs: 1_500,
      reasoningTokens: 60,
      generation: { tokens: 89, ms: 4_000 },
      derived: ['reasoningTokens'],
    };

    it('reads back the stats a reply was stored with, after a restart', async () => {
      const { id } = await store.create();
      await store.appendMessage(id, {
        id: 'r1',
        role: 'assistant',
        content: 'done',
        createdAt: '2026-01-01T00:00:00.000Z',
        stats,
        usage: { outputTokens: 90, rate: { evalTokens: 90, evalMs: 3_000, cachedPromptTokens: 12 } },
      });

      const reopened = await new SessionStore(directory, MODEL).get(id);
      expect(reopened?.messages[0]).toMatchObject({
        stats,
        usage: { rate: { cachedPromptTokens: 12 } },
      });
    });

    it('loads a conversation stored before stats were kept exactly as it was written', async () => {
      const messages = [
        { id: 'u1', role: 'user', content: 'hi', createdAt: '2025-01-01T00:00:00.000Z' },
        {
          id: 'a1',
          role: 'assistant',
          content: 'hello',
          createdAt: '2025-01-01T00:00:01.000Z',
          usage: { inputTokens: 5, outputTokens: 2, rate: { evalTokens: 2, evalMs: 40 } },
          rounds: [{ text: 'hello', toolCallIds: [], timing: { startedAt: 1, firstTokenAt: 2, endedAt: 3 } }],
        },
      ];
      await writeFile(
        join(directory, 'old-session.json'),
        JSON.stringify({
          id: 'old-session',
          title: 'Old',
          model: MODEL,
          createdAt: '2025-01-01T00:00:00.000Z',
          messages,
        }),
        'utf8'
      );

      const loaded = await store.get('old-session');
      expect(loaded?.messages).toEqual(messages);
      expect(loaded?.messages[1]).not.toHaveProperty('stats');
    });
  });
});

describe('agent titles', () => {
  it('reads who may retitle a session from how its title was locked', () => {
    const origin = { parentSessionId: 'p', depth: 1, seedPrompt: 's' };
    expect(agentMayRetitle({})).toBe(true);
    expect(agentMayRetitle({ titleLocked: true, titleSource: 'agent' })).toBe(true);
    expect(agentMayRetitle({ titleLocked: true, titleSource: 'user', origin })).toBe(false);
    // Locked at spawn time by the parent agent.
    expect(agentMayRetitle({ titleLocked: true, origin })).toBe(true);
    // Locked before titleSource existed, on a session the user made: only a hand rename did that.
    expect(agentMayRetitle({ titleLocked: true })).toBe(false);
  });

  it('locks an agent title, refuses over a user rename, and survives a reload', async () => {
    const { store, directory } = await freshStore();
    const created = await store.create();

    const first = await store.renameByAgent(created.id, '  Agent   title ');
    expect(first).toMatchObject({
      ok: true,
      summary: { title: 'Agent title', titleLocked: true, titleSource: 'agent' },
    });
    expect(await new SessionStore(directory, MODEL).get(created.id)).toMatchObject({ titleSource: 'agent' });

    await store.rename(created.id, 'User title');
    expect(await store.renameByAgent(created.id, 'Again')).toEqual({ ok: false, reason: 'user-title' });
    expect(await store.get(created.id)).toMatchObject({ title: 'User title', titleSource: 'user' });
    expect(await store.renameByAgent('00000000-0000-4000-8000-000000000000', 'x')).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('keeps the generator off an agent-set title', async () => {
    const { store } = await freshStore();
    const created = await store.create();
    await store.renameByAgent(created.id, 'Agent title');
    expect(await store.applyGeneratedTitle(created.id, 'Generated')).toBeNull();
    expect((await store.get(created.id))?.title).toBe('Agent title');
  });
});

describe('approval', () => {
  describe('SessionStore approval mode', () => {
    let directory: string;
    /** Beside the sessions directory, the way the app places it. */
    let preferenceFile: string;
    let store: SessionStore;

    /**
     * The same files, as a later run of the app sees them - including the preference, which is
     * read from disk again rather than from the instance that wrote it.
     */
    const relaunch = () =>
      new SessionStore(directory, 'test-model', 'launch-two', undefined, new ApprovalModePreference(preferenceFile));

    beforeEach(async () => {
      const base = await mkdtemp(join(tmpdir(), 'b4m-approval-store-'));
      directory = join(base, 'sessions');
      preferenceFile = join(base, 'approval-mode.json');
      store = new SessionStore(
        directory,
        'test-model',
        'launch-one',
        undefined,
        new ApprovalModePreference(preferenceFile)
      );
    });

    it('starts a new conversation at "Approve for me"', async () => {
      const created = await store.create();
      expect(created.approvalMode).toBe('auto');
      expect(await store.approvalMode(created.id)).toBe('auto');
    });

    /**
     * The preference is about the NEXT conversation. A mode chosen in one thread must not reach
     * back into the threads already on disk, whose stored mode is their own.
     */
    it('starts the next conversation in the mode the user picked last', async () => {
      const first = await store.create();
      await store.setApprovalMode(first.id, 'ask');

      const second = await store.create();
      expect(second.approvalMode).toBe('ask');
      expect(await store.approvalMode(first.id)).toBe('ask');
    });

    it('keeps that pick across a relaunch, so it is not re-made every morning', async () => {
      const first = await store.create();
      await store.setApprovalMode(first.id, 'ask');
      expect((await relaunch().create()).approvalMode).toBe('ask');
    });

    /**
     * 'full' is scoped to the run of the app it was chosen in, so a new conversation inheriting
     * it would outlive the choice - the same reason a spawned session does not inherit it.
     */
    it('never carries "Full access" into the next conversation', async () => {
      const first = await store.create();
      await store.setApprovalMode(first.id, 'full');

      const second = await store.create();
      expect(second.approvalMode).toBe('auto');
      expect(second.approvalMode).not.toBe('full');
      expect((await relaunch().create()).approvalMode).toBe('auto');
    });

    it('leaves a conversation already on disk at the mode it was given', async () => {
      const existing = await store.create();
      await store.setApprovalMode(existing.id, 'auto');

      const later = await store.create();
      await store.setApprovalMode(later.id, 'ask');

      expect(await store.approvalMode(existing.id)).toBe('auto');
    });

    it('starts at "Approve for me" when no preference has been written', async () => {
      const fresh = new SessionStore(directory, 'test-model', 'launch-one');
      expect((await fresh.create()).approvalMode).toBe('auto');
    });

    it('reads a conversation written before approval modes existed as ask', async () => {
      const created = await store.create();
      const path = join(directory, `${created.id}.json`);
      const legacy = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      delete legacy.approvalMode;
      await store.setApprovalMode(created.id, 'ask');
      expect((await store.get(created.id))?.approvalMode).toBe('ask');
    });

    it('keeps "Approve for me" across a relaunch, which is the point of persisting it at all', async () => {
      const created = await store.create();
      await store.setApprovalMode(created.id, 'auto');
      expect(await relaunch().approvalMode(created.id)).toBe('auto');
    });

    /**
     * The deliberate asymmetry. 'full' is the mode with nothing between a crafted prompt and a
     * read of any file on the machine, and it is chosen for a piece of work the user is watching;
     * one that quietly outlived the app it was set in is not the thing they chose.
     */
    it('drops "Full access" back to asking on the next launch', async () => {
      const created = await store.create();
      await store.setApprovalMode(created.id, 'full');
      expect(await store.approvalMode(created.id)).toBe('full');

      expect(await relaunch().approvalMode(created.id)).toBe('ask');
    });

    it('lands a stale "Full access" on ask rather than on the next mode down', async () => {
      const created = await store.create();
      await store.setApprovalMode(created.id, 'full');
      const reopened = relaunch();
      expect(await reopened.approvalMode(created.id)).toBe('ask');

      // And the stamp does not survive: re-choosing 'full' in the new run has to be its own act.
      await reopened.setApprovalMode(created.id, 'auto');
      expect(await new SessionStore(directory, 'test-model', 'launch-three').approvalMode(created.id)).toBe('auto');
    });

    it('keeps the mode through an unrelated write, so a turn does not reset it', async () => {
      const created = await store.create();
      await store.setApprovalMode(created.id, 'auto');
      await store.appendMessage(created.id, {
        id: 'm1',
        role: 'user',
        content: 'hello',
        createdAt: new Date().toISOString(),
      });
      expect(await store.approvalMode(created.id)).toBe('auto');
    });

    it('reads a session that is not there as ask, which fails closed', async () => {
      const created = await store.create();
      const path = join(directory, `${created.id}.json`);
      const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      expect(raw.approvalMode).toBe('auto');
      expect(await store.approvalMode('no-such-session')).toBe('ask');
    });

    /** A spawn names the mode it inherited, and that beats the preference without recording it. */
    it('carries an inherited mode onto a session created with one', async () => {
      const child = await store.create('test-model', { approvalMode: 'ask' });
      expect(child.approvalMode).toBe('ask');
      expect((await store.create()).approvalMode).toBe('auto');
    });
  });
});

describe('defaults', () => {
  describe('read-only new-session defaults', () => {
    it.each(['ask', 'auto', 'full'] as const)(
      'reuses normalized remembered %s preferences without creating a session',
      async remembered => {
        const base = await mkdtemp(join(tmpdir(), 'b4m-draft-defaults-'));
        const sessions = join(base, 'sessions');
        const approvalFile = join(base, 'approval.json');
        const cacheFile = join(base, 'cache.json');
        const approvals = new ApprovalModePreference(approvalFile);
        const cache = new PromptCacheTtlPreference(cacheFile);
        await approvals.record(remembered);
        await cache.record('1h');
        const before = await Promise.all([readFile(approvalFile, 'utf8'), readFile(cacheFile, 'utf8')]);
        const store = new SessionStore(sessions, 'build-model', 'launch', undefined, approvals, 'high', cache);
        const defaults = await store.defaultsForNewSession('effective-model');
        expect(defaults).toEqual({
          model: 'effective-model',
          approvalMode: remembered === 'full' ? 'auto' : remembered,
          reasoningEffort: 'high',
          promptCacheTtl: '1h',
        });
        await expect(stat(sessions)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await Promise.all([readFile(approvalFile, 'utf8'), readFile(cacheFile, 'utf8')])).toEqual(before);
        expect(await store.create('effective-model')).toMatchObject(defaults);
      }
    );
  });
});

describe('effort', () => {
  const MODEL = 'test-model';

  async function root(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'b4m-effort-'));
  }

  /** What a conversation written before the picker existed looks like: no `reasoningEffort` at all. */
  const LEGACY_ID = 'c0f24b0e-4e40-4a1d-9a2b-2c7d8f0e1a33';
  const LEGACY_SESSION = `{
  "id": "${LEGACY_ID}",
  "title": "an older conversation",
  "model": "gpt-5",
  "createdAt": "2026-09-01T00:00:00.000Z",
  "updatedAt": "2026-09-01T00:00:00.000Z",
  "mode": "chat",
  "approvalMode": "ask",
  "messages": []
}`;

  describe('SessionStore reasoning effort', () => {
    it('starts a new conversation at the launch default', async () => {
      const directory = await root();
      const store = new SessionStore(directory, MODEL, 'launch-one', undefined, undefined, 'high');
      const created = await store.create();
      expect(created.reasoningEffort).toBe('high');
    });

    it('leaves a conversation written before the setting existed on the launch default', async () => {
      const directory = await root();
      await writeFile(join(directory, `${LEGACY_ID}.json`), LEGACY_SESSION, 'utf8');

      expect((await new SessionStore(directory, MODEL).get(LEGACY_ID))?.reasoningEffort).toBe('default');
      const benchmark = new SessionStore(directory, MODEL, 'launch-two', undefined, undefined, 'low');
      expect((await benchmark.get(LEGACY_ID))?.reasoningEffort).toBe('low');
    });

    it('keeps a chosen effort across a relaunch that sets a different default', async () => {
      const directory = await root();
      const store = new SessionStore(directory, MODEL, 'launch-one', undefined, undefined, 'high');
      const created = await store.create();
      await store.setReasoningEffort(created.id, 'minimal');

      const relaunched = new SessionStore(directory, MODEL, 'launch-two', undefined, undefined, 'medium');
      expect((await relaunched.get(created.id))?.reasoningEffort).toBe('minimal');
    });

    it('round-trips an explicit default rather than reading it back as "never chosen"', async () => {
      const directory = await root();
      const store = new SessionStore(directory, MODEL, 'launch-one', undefined, undefined, 'high');
      const created = await store.create();
      await store.setReasoningEffort(created.id, 'default');

      expect(JSON.parse(await readFile(join(directory, `${created.id}.json`), 'utf8')).reasoningEffort).toBe('default');
      const relaunched = new SessionStore(directory, MODEL, 'launch-two', undefined, undefined, 'high');
      expect((await relaunched.get(created.id))?.reasoningEffort).toBe('default');
    });

    it('stores an effort the current model cannot use, so switching back restores it', async () => {
      const directory = await root();
      const store = new SessionStore(directory, MODEL, 'launch-one');
      const created = await store.create('claude-5-opus');
      await store.setReasoningEffort(created.id, 'high');
      await store.setModel(created.id, 'gpt-5');

      expect((await store.get(created.id))?.reasoningEffort).toBe('high');
    });

    it('answers null for a session that is gone', async () => {
      const store = new SessionStore(await root(), MODEL);
      expect(await store.setReasoningEffort('d4a2c1b0-0000-4000-8000-000000000000', 'high')).toBeNull();
    });
  });
});

describe('generation', () => {
  const MODEL = 'test-model';

  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  async function root(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-generation-store-'));
    roots.push(directory);
    return directory;
  }

  const ID = 'c0f24b0e-4e40-4a1d-9a2b-2c7d8f0e1a34';

  function sessionFile(extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      id: ID,
      title: 'an older conversation',
      model: 'gpt-5',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      mode: 'chat',
      approvalMode: 'ask',
      messages: [],
      ...extra,
    });
  }

  describe('SessionStore generation settings', () => {
    it('keeps the overrides across a relaunch and a model switch, without touching updatedAt', async () => {
      const directory = await root();
      const store = new SessionStore(directory, MODEL);
      const created = await store.create();
      const before = (await store.get(created.id))?.updatedAt;
      await store.setGeneration(created.id, { temperature: 0.4, maxOutputTokens: 4096 });
      expect((await store.get(created.id))?.updatedAt).toBe(before);
      await store.setModel(created.id, 'another-model');

      const relaunched = new SessionStore(directory, MODEL);
      expect((await relaunched.get(created.id))?.generation).toEqual({ temperature: 0.4, maxOutputTokens: 4096 });
    });

    it('clears the field from the file when the overrides are emptied', async () => {
      const directory = await root();
      const store = new SessionStore(directory, MODEL);
      const created = await store.create();
      await store.setGeneration(created.id, { topP: 0.9 });
      await store.setGeneration(created.id, {});

      expect(JSON.parse(await readFile(join(directory, `${created.id}.json`), 'utf8'))).not.toHaveProperty(
        'generation'
      );
      expect((await store.get(created.id))?.generation).toBeUndefined();
    });

    it('loads a conversation written before the setting existed with no overrides', async () => {
      const directory = await root();
      await writeFile(join(directory, `${ID}.json`), sessionFile(), 'utf8');
      const session = await new SessionStore(directory, MODEL).get(ID);
      expect(session?.title).toBe('an older conversation');
      expect(session).not.toHaveProperty('generation');
    });

    it('keeps only the numeric fields it knows from a damaged file', async () => {
      const directory = await root();
      await writeFile(
        join(directory, `${ID}.json`),
        sessionFile({ generation: { temperature: 'hot', topK: 30, seed: 5 } }),
        'utf8'
      );
      expect((await new SessionStore(directory, MODEL).get(ID))?.generation).toEqual({ topK: 30 });

      await writeFile(join(directory, `${ID}.json`), sessionFile({ generation: [0.5] }), 'utf8');
      expect(await new SessionStore(directory, MODEL).get(ID)).not.toHaveProperty('generation');
    });

    it('does not rewrite the file for the overrides it already holds', async () => {
      const store = new SessionStore(await root(), MODEL);
      const created = await store.create();
      await store.setGeneration(created.id, { topP: 0.9, temperature: 0.4 });
      const write = vi.spyOn(store as unknown as { write: () => Promise<void> }, 'write');
      expect(await store.setGeneration(created.id, { topP: 0.9, temperature: 0.4 })).toMatchObject({ id: created.id });
      expect(write).not.toHaveBeenCalled();
    });

    it('answers null for a session that is gone', async () => {
      const store = new SessionStore(await root(), MODEL);
      expect(await store.setGeneration('d4a2c1b0-0000-4000-8000-000000000000', { temperature: 1 })).toBeNull();
    });
  });
});

describe('modes', () => {
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
      const created = await store.create(MODEL, { project: PROJECT });
      expect(created.mode).toBe('code');

      const loaded = await store.get(created.id);
      expect(loaded?.project).toEqual(PROJECT);
    });

    it('leaves a Code session untitled so the first prompt still names it', async () => {
      const created = await store.create(MODEL, { project: PROJECT });
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
      const created = await store.create(MODEL, { project: PROJECT });
      await store.addContextDirectory(created.id, '/repos/another');
      await store.addContextDirectory(created.id, '/repos/another');

      expect((await store.get(created.id))?.project?.contextDirectories).toEqual([
        '/repos/reference',
        '/repos/another',
      ]);

      await store.removeContextDirectory(created.id, '/repos/reference');
      expect((await store.get(created.id))?.project?.contextDirectories).toEqual(['/repos/another']);
    });

    it('reports no removal for an absent path even when the session has a project', async () => {
      const created = await store.create(MODEL, { project: PROJECT });
      expect(await store.removeContextDirectory(created.id, '/not-granted')).toBeNull();
      expect((await store.get(created.id))?.project?.contextDirectories).toEqual(PROJECT.contextDirectories);
      expect(await store.removeContextDirectory('missing-session', '/repos/reference')).toBeNull();
    });

    it('refuses a context directory on a Chat session, which has no project to put it in', async () => {
      const created = await store.create();
      expect(await store.addContextDirectory(created.id, '/repos/another')).toBeNull();
    });

    // Deleting a conversation must never be a way to lose a worktree that holds uncommitted work.
    it('deletes the session without touching the project directory', async () => {
      const created = await store.create(MODEL, { project: PROJECT });
      await store.delete(created.id);

      expect(await store.get(created.id)).toBeNull();
    });
  });
});

describe('Studio mode', () => {
  it('keeps a Studio session Studio across a fresh read, with no project', async () => {
    const { store, directory } = await freshStore();
    const created = await store.create(MODEL, { mode: 'studio' });
    expect(created.mode).toBe('studio');

    const reopened = new SessionStore(directory, MODEL);
    const read = await reopened.get(created.id);
    expect(read?.mode).toBe('studio');
    expect(read?.project).toBeUndefined();
    expect((await reopened.list()).find(entry => entry.id === created.id)?.mode).toBe('studio');
  });

  it('reads a mode it does not know as Chat', async () => {
    const { store, directory } = await freshStore();
    const created = await store.create(MODEL);
    const file = join(directory, `${created.id}.json`);
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...raw, mode: 'agents' }), 'utf8');
    expect((await new SessionStore(directory, MODEL).get(created.id))?.mode).toBe('chat');
  });
});

describe('prompt cache TTL', () => {
  const MODEL = 'claude-opus-5-5';

  async function root(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'b4m-cache-ttl-'));
  }

  function storeWith(directory: string, preferenceFile: string, launchId = 'launch-one'): SessionStore {
    return new SessionStore(
      join(directory, 'sessions'),
      MODEL,
      launchId,
      undefined,
      undefined,
      'default',
      new PromptCacheTtlPreference(preferenceFile)
    );
  }

  describe('PromptCacheTtlPreference', () => {
    it('reads 5 minutes until something is recorded, and the recorded lifetime after', async () => {
      const file = join(await root(), 'prompt-cache-ttl.json');
      expect(await new PromptCacheTtlPreference(file).read()).toBe('5m');

      await new PromptCacheTtlPreference(file).record('1h');
      expect(await new PromptCacheTtlPreference(file).read()).toBe('1h');
    });

    it('falls back to 5 minutes on a file it cannot use', async () => {
      const file = join(await root(), 'prompt-cache-ttl.json');
      await writeFile(file, '{"ttl":"1d"}', 'utf8');
      expect(await new PromptCacheTtlPreference(file).read()).toBe('5m');
      await writeFile(file, 'not json', 'utf8');
      expect(await new PromptCacheTtlPreference(file).read()).toBe('5m');
    });
  });

  describe('SessionStore prompt cache lifetime', () => {
    it('stores a pick on the conversation and starts the next conversation with it', async () => {
      const directory = await root();
      const preference = join(directory, 'prompt-cache-ttl.json');
      const store = storeWith(directory, preference);
      const first = await store.create();
      expect(first.promptCacheTtl).toBe('5m');

      const summary = await store.setPromptCacheTtl(first.id, '1h');
      expect(summary?.promptCacheTtl).toBe('1h');
      expect(summary?.updatedAt).toBe(first.updatedAt);

      const relaunched = storeWith(directory, preference, 'launch-two');
      expect((await relaunched.get(first.id))?.promptCacheTtl).toBe('1h');
      expect((await relaunched.create()).promptCacheTtl).toBe('1h');
    });

    it('drops a stored value it does not recognise and leaves the preference alone for a missing session', async () => {
      const directory = await root();
      const preference = join(directory, 'prompt-cache-ttl.json');
      const store = storeWith(directory, preference);
      const created = await store.create();
      const file = join(directory, 'sessions', `${created.id}.json`);
      await writeFile(
        file,
        JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), promptCacheTtl: '1d' }),
        'utf8'
      );

      expect((await storeWith(directory, preference, 'launch-two').get(created.id))?.promptCacheTtl).toBeUndefined();
      expect(await store.setPromptCacheTtl('3f0c2c55-9a43-4cf6-8d0e-1b1f0a2b3c4d', '1h')).toBeNull();
      expect(await new PromptCacheTtlPreference(preference).read()).toBe('5m');
    });
  });
});

describe('suggestions', () => {
  function suggestion(id: string, changes: Partial<ChatSpawnSuggestion> = {}): ChatSpawnSuggestion {
    return {
      id,
      title: id,
      prompt: `task ${id}`,
      base: 'main',
      branch: `agent/${id}`,
      status: 'pending',
      revision: 0,
      createdAt: '2026-10-14T00:00:00.000Z',
      ...changes,
    };
  }

  describe('SessionStore spawn suggestions', () => {
    let store: SessionStore;
    let sessionId: string;

    beforeEach(async () => {
      store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-store-suggest-')), 'test-model');
      sessionId = (await store.create()).id;
      await store.appendMessage(sessionId, { id: 'm1', role: 'user', content: 'hi', createdAt: 'now' });
    });

    it('reports each outcome onto one message once, then drops what no longer needs showing', async () => {
      await store.changeSpawnSuggestions(sessionId, () => [
        suggestion('a', { status: 'dismissed', dismissedBy: 'user', unreported: true }),
        suggestion('b', {
          status: 'started',
          unreported: true,
          started: { sessionId: 'child', title: 'b', placement: 'local', edited: false },
        }),
        suggestion('c'),
      ]);

      const reported = await store.reportSpawnSuggestions(sessionId, 'm1', entry => `note ${entry.id}`);
      expect(reported?.notes).toEqual(['note a', 'note b']);
      expect(reported?.suggestions.map(entry => entry.id)).toEqual(['b', 'c']);
      expect(reported?.suggestions.some(entry => entry.unreported)).toBe(false);

      expect(await store.reportSpawnSuggestions(sessionId, 'm1', entry => `note ${entry.id}`)).toBeNull();
      expect((await store.get(sessionId))?.messages[0]?.notes).toEqual(['note a', 'note b']);
    });

    it('keeps an outcome unreported when its message is missing', async () => {
      await store.changeSpawnSuggestions(sessionId, () => [suggestion('a', { status: 'dismissed', unreported: true })]);
      expect(await store.reportSpawnSuggestions(sessionId, 'gone', () => 'x')).toBeNull();
      expect((await store.spawnSuggestions(sessionId))[0]?.unreported).toBe(true);
    });

    it('caps reported starts at the newest 20 and never drops a pending one', async () => {
      const started = Array.from({ length: 25 }, (_, index) => suggestion(`s${index}`, { status: 'started' }));
      const after = await store.changeSpawnSuggestions(sessionId, () => [suggestion('p'), ...started]);
      expect(after).toHaveLength(21);
      expect(after?.[0]?.id).toBe('p');
      expect(after?.[1]?.id).toBe('s5');
    });

    it('drops pending suggestions on archive and keeps the started ones', async () => {
      await store.changeSpawnSuggestions(sessionId, () => [suggestion('a'), suggestion('b', { status: 'started' })]);
      await store.setArchived(sessionId, true);
      expect((await store.spawnSuggestions(sessionId)).map(entry => entry.id)).toEqual(['b']);
    });

    it('loses no message when a suggestion write overlaps an append', async () => {
      await Promise.all([
        store.appendMessage(sessionId, { id: 'm2', role: 'assistant', content: 'reply', createdAt: 'now' }),
        store.changeSpawnSuggestions(sessionId, current => [...current, suggestion('a')]),
        store.appendMessage(sessionId, { id: 'm3', role: 'user', content: 'more', createdAt: 'now' }),
      ]);
      const stored = await store.get(sessionId);
      expect(stored?.messages.map(message => message.id)).toEqual(['m1', 'm2', 'm3']);
      expect(stored?.spawnSuggestions?.map(entry => entry.id)).toEqual(['a']);
    });
  });
});

describe('truncate', () => {
  const MODEL = 'test-model';
  const at = '2026-11-01T00:00:00.000Z';

  function message(id: string, role: ChatMessage['role'], extra: Partial<ChatMessage> = {}): ChatMessage {
    return { id, role, content: id, createdAt: at, ...extra };
  }

  async function seeded(messages: ChatMessage[]) {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-truncate-'));
    const store = new SessionStore(directory, MODEL);
    const session = await store.create();
    for (const entry of messages) await store.appendMessage(session.id, entry);
    return { directory, store, id: session.id };
  }

  describe('SessionStore.truncateFrom', () => {
    it('drops the message and everything after it, with what those turns carried, and persists it', async () => {
      const { directory, store, id } = await seeded([
        message('u1', 'user'),
        message('a1', 'assistant'),
        message('u2', 'user', {
          attachments: [
            { id: 'att', kind: 'text', name: 'a.txt', mediaType: 'text/plain', byteSize: 1, sourceBytes: 1 },
          ],
        }),
        message('a2', 'assistant', {
          toolCalls: [{ id: 'call', name: 'file_write', input: {}, status: 'done' }],
          artifacts: [{ id: 'art', type: 'html', title: 't', content: '<p/>' } as never],
        }),
      ]);

      const truncated = await store.truncateFrom(id, 'u2');
      expect(truncated && truncated.messages.map(entry => entry.id)).toEqual(['u1', 'a1']);

      const reopened = await new SessionStore(directory, MODEL).get(id);
      expect(reopened?.messages.map(entry => entry.id)).toEqual(['u1', 'a1']);
      expect(reopened?.messages.some(entry => entry.toolCalls || entry.artifacts || entry.attachments)).toBe(false);
    });

    it('takes a /compact marker after the cut with it, so the history before it is live again', async () => {
      const { store, id } = await seeded([
        message('u1', 'user'),
        message('a1', 'assistant'),
        message('u2', 'user'),
        message('b', 'user', { boundary: { kind: 'compact' }, content: 'summary' }),
        message('u3', 'user'),
      ]);
      const truncated = await store.truncateFrom(id, 'u2');
      expect(truncated && truncated.messages.some(entry => entry.boundary)).toBe(false);
    });

    it('answers false and writes nothing when the message is gone or admit rejects it', async () => {
      const { store, id } = await seeded([message('u1', 'user'), message('a1', 'assistant')]);
      const before = (await store.get(id))?.updatedAt;

      expect(await store.truncateFrom(id, 'missing')).toBe(false);
      expect(await store.truncateFrom(id, 'a1', entry => entry.role === 'user')).toBe(false);
      const after = await store.get(id);
      expect(after?.messages).toHaveLength(2);
      expect(after?.updatedAt).toBe(before);
    });

    it('answers null for a session that does not exist', async () => {
      const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-truncate-')), MODEL);
      expect(await store.truncateFrom('d4a2c1b0-0000-4000-8000-000000000000', 'u1')).toBeNull();
    });

    it('marks an imported conversation forked, so a later sync cannot overwrite the rewound thread', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'b4m-truncate-'));
      const id = 'c0f24b0e-4e40-4a1d-9a2b-2c7d8f0e1a34';
      await writeFile(
        join(directory, `${id}.json`),
        JSON.stringify({
          id,
          title: 'imported',
          model: MODEL,
          createdAt: at,
          updatedAt: at,
          mode: 'chat',
          approvalMode: 'ask',
          importOrigin: { kind: 'claude-code', sourceId: 'source', importedAt: at, sourceUpdatedAt: at },
          messages: [message('u1', 'user'), message('a1', 'assistant')],
        }),
        'utf8'
      );
      const store = new SessionStore(directory, MODEL);
      const truncated = await store.truncateFrom(id, 'a1');
      expect(truncated && truncated.importOrigin?.forkedAt).toBeTruthy();
    });
  });
});

describe('orchestration', () => {
  const contract = {
    version: 1 as const,
    outcome: 'Bounded task',
    rationale: 'Focused scope',
    role: 'implementation' as const,
    paths: [],
    contextReferences: [],
    ownedChanges: [],
    coordinationConstraints: [],
    nonGoals: [],
    acceptanceCriteria: ['Observed result'],
    verification: [],
    assumptions: [],
    escalationConditions: [],
  };

  it.each(['state', 'model', 'append', 'update'] as const)('resets attentionViewed on %s changes', async change => {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-task-viewed-')), 'worker');
    const child = await store.create('worker', {
      workerSelection: { role: 'implementation', effectiveModel: 'worker', source: 'override', rootRunId: 'run' },
      workerTask: {
        version: 1,
        contract,
        automaticUpgrades: 0,
        resolvedDecisions: [],
        attempts: [{ id: 'attempt', model: 'worker', startedAt: '2026-11-19', trigger: 'initial' }],
        state: { status: 'queued' },
        attentionViewed: true,
      },
    });
    if (change === 'state') await store.updateWorkerTask(child.id, task => ({ ...task, state: { status: 'running' } }));
    if (change === 'model') await store.setWorkerModel(child.id, 'reviewer', store.scopeKey());
    if (change === 'append' || change === 'update') {
      await store.appendMessage(child.id, {
        id: 'reply',
        role: 'assistant',
        content: 'Hello',
        createdAt: '2026-11-19',
      });
      if (change === 'update') {
        await store.updateWorkerTask(child.id, task => ({ ...task, attentionViewed: true }));
        await store.updateMessage(child.id, 'reply', { content: 'New reply' });
      }
    }
    expect((await store.get(child.id))?.workerTask?.attentionViewed).not.toBe(true);
  });

  it('isolates future defaults by account/environment, preserving root snapshots and legacy sessions across restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-role-policy-'));
    let scope: SessionScope | null = { environmentUrl: 'https://example.test', accountId: 'first' };
    const store = new SessionStore(directory, 'planner', 'launch-one', () => scope);
    const policy = {
      ...inheritancePolicy(),
      roles: { implementation: 'worker', exploration: 'inherit', review: 'inherit' },
    };
    const legacy = await store.create();
    await store.setRolePolicy(policy);
    const root = await store.create('planner', {
      orchestrationPolicy: { rootSessionId: legacy.id, rootRunId: 'run-one', policy },
    });
    await store.setRolePolicy(inheritancePolicy());
    expect((await store.get(root.id))?.orchestrationPolicy?.policy).toEqual(policy);
    scope = { environmentUrl: 'https://example.test', accountId: 'second' };
    expect(await store.getRolePolicy()).toEqual(inheritancePolicy());
    expect(await store.get(root.id)).toBeNull();
    await store.setRolePolicy(policy);
    scope = { environmentUrl: 'https://other.test', accountId: 'second' };
    expect(await store.getRolePolicy()).toEqual(inheritancePolicy());
    scope = { environmentUrl: 'https://example.test', accountId: 'second' };
    expect(await new SessionStore(directory, 'planner', 'launch-two', () => scope).getRolePolicy()).toEqual(policy);
    scope = { environmentUrl: 'https://example.test', accountId: 'first' };
    const restarted = new SessionStore(directory, 'planner', 'launch-two', () => scope);
    expect((await restarted.get(root.id))?.orchestrationPolicy?.rootRunId).toBe('run-one');
    expect((await restarted.get(legacy.id))?.workerTask).toBeUndefined();
    expect((await restarted.get(legacy.id))?.model).toBe('planner');
    scope = null;
    await expect(store.getRolePolicy()).rejects.toThrow(/account/);
  });

  it('retains pending decisions, resolved decision IDs, attempt lineage and accepted evidence through restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-task-restart-'));
    const store = new SessionStore(directory, 'planner', 'launch-one');
    const root = await store.create();
    const child = await store.create('worker', {
      origin: { parentSessionId: root.id, depth: 1, seedPrompt: 'Brief' },
      orchestrationPolicy: { rootSessionId: root.id, rootRunId: 'run-one', policy: inheritancePolicy() },
      workerSelection: {
        role: 'implementation',
        requestedModelId: 'worker',
        effectiveModel: 'worker',
        source: 'override',
        rootRunId: 'run-one',
      },
      workerTask: {
        version: 1,
        contract,
        automaticUpgrades: 0,
        resolvedDecisions: ['previous-decision'],
        attempts: [{ id: 'attempt-one', model: 'worker', startedAt: '2026-11-07', trigger: 'initial' }],
        state: {
          status: 'escalation-requested',
          decisionId: 'pending-decision',
          reason: 'Assumption disproven',
          evidence: ['Observed incompatible interface'],
          requestedModelId: 'reviewer',
        },
      },
    });
    const restarted = new SessionStore(directory, 'planner', 'launch-two');
    expect((await restarted.get(child.id))?.workerTask).toEqual(child.workerTask);
    expect((await restarted.get(child.id))?.workerSelection).toEqual(child.workerSelection);
    await restarted.updateWorkerTask(child.id, task => ({
      ...task,
      state: {
        status: 'completed',
        accepted: true,
        assessment: 'Reviewed observation',
        changedPaths: [],
        verification: [
          {
            criterion: 'Observed result',
            command: 'inspect',
            outcome: 'passed',
            evidence: 'Observed expected behavior',
          },
        ],
        unmetCriteria: [],
        handoff: 'Ready',
      },
    }));
    const restored = await new SessionStore(directory, 'planner', 'launch-three').get(child.id);
    expect(restored?.workerTask?.state).toMatchObject({
      status: 'completed',
      accepted: true,
      assessment: 'Reviewed observation',
    });
    expect(restored?.workerTask?.attempts).toHaveLength(1);
    expect(restored?.workerTask?.resolvedDecisions).toEqual(['previous-decision']);
    await restarted.updateWorkerTask(child.id, task => ({
      ...task,
      state: { status: 'canceled', reason: 'Canceled by user' },
    }));
    await expect(restarted.setWorkerModel(child.id, 'reviewer', restarted.scopeKey())).rejects.toThrow(/Canceled/);
    expect((await restarted.get(child.id))?.model).toBe('worker');
  });

  it('keeps the initial and newest 31 attempts when another attempt is appended', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-task-attempts-'));
    const store = new SessionStore(directory, 'worker');
    const attempts = Array.from({ length: 32 }, (_, index) => ({
      id: `attempt-${index}`,
      model: 'worker',
      startedAt: '2026-11-07',
      trigger: 'revision' as const,
    }));
    const child = await store.create('worker', {
      workerTask: {
        version: 1,
        contract,
        automaticUpgrades: 0,
        resolvedDecisions: [],
        attempts,
        state: { status: 'queued' },
      },
    });
    const latest = { ...attempts[31], id: 'attempt-32' };
    const updated = await store.updateWorkerTask(child.id, task => ({
      ...task,
      attempts: [...task.attempts, latest],
    }));
    const expected = [attempts[0], ...attempts.slice(2), latest];
    expect(updated?.workerTask?.attempts).toEqual(expected);
    expect((await new SessionStore(directory, 'worker').get(child.id))?.workerTask?.attempts).toEqual(expected);
  });

  it.each(['orchestrationPolicy', 'workerSelection', 'workerTask'] as const)(
    'keeps a session with malformed %s visible and readable',
    async field => {
      const directory = await mkdtemp(join(tmpdir(), 'b4m-task-malformed-'));
      const store = new SessionStore(directory, 'worker');
      const child = await store.create();
      const session = await store.get(child.id);
      await writeFile(join(directory, `${child.id}.json`), JSON.stringify({ ...session, [field]: { version: 99 } }));
      const restarted = new SessionStore(directory, 'worker');
      expect((await restarted.list()).map(entry => entry.id)).toContain(child.id);
      expect((await restarted.get(child.id))?.[field]).toBeUndefined();
    }
  );

  it.each(['{', '{"version":99}'])('falls back to inheritance for malformed saved role policy %s', async contents => {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-role-policy-malformed-'));
    const store = new SessionStore(directory, 'worker');
    await store.setRolePolicy(inheritancePolicy());
    await writeFile(join(directory, '.role-policy'), contents);
    expect(await store.getRolePolicy()).toEqual(inheritancePolicy());
  });

  it('drops a root policy snapshot when orchestrate expires on restart, keeping a worker policy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-policy-reseed-'));
    const first = new SessionStore(directory, 'planner', 'launch-one');
    const policy = inheritancePolicy();
    const root = await first.create('planner', {
      orchestrationPolicy: { rootSessionId: 'root', rootRunId: 'run-one', policy },
    });
    await first.setOrchestrate(root.id, true);
    const child = await first.create('worker', {
      origin: { parentSessionId: root.id, depth: 1, seedPrompt: 'Brief' },
      orchestrationPolicy: { rootSessionId: root.id, rootRunId: 'run-one', policy },
    });
    const same = new SessionStore(directory, 'planner', 'launch-one');
    expect((await same.get(root.id))?.orchestrationPolicy?.rootRunId).toBe('run-one');
    const restarted = new SessionStore(directory, 'planner', 'launch-two');
    const reloaded = await restarted.get(root.id);
    expect(reloaded?.orchestrate).toBeUndefined();
    expect(reloaded?.orchestrationPolicy).toBeUndefined();
    expect((await restarted.get(child.id))?.orchestrationPolicy?.rootRunId).toBe('run-one');
  });

  it('keeps a budgeted root policy, with its pause, when orchestrate expires on restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-policy-budget-'));
    const first = new SessionStore(directory, 'planner', 'launch-one');
    const budgeted = {
      rootSessionId: 'root',
      rootRunId: 'run-one',
      serverRunId: 'server-run',
      budgetCredits: 100,
      budgetPaused: true as const,
      policy: inheritancePolicy(),
    };
    const root = await first.create('planner', { orchestrationPolicy: budgeted });
    await first.setOrchestrate(root.id, true);

    const reloaded = await new SessionStore(directory, 'planner', 'launch-two').get(root.id);
    expect(reloaded?.orchestrate).toBeUndefined();
    expect(reloaded?.orchestrationPolicy).toEqual(budgeted);
  });

  it('records a budget field only while the budget is the expected one', async () => {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-policy-guard-')), 'planner');
    const root = await store.create('planner', {
      orchestrationPolicy: { rootSessionId: 'root', rootRunId: 'run', budgetCredits: 200, policy: inheritancePolicy() },
    });
    expect(await store.setRunBudget(root.id, 'run', { budgetWarnedAt: 100 }, undefined, 100)).toBeNull();
    expect((await store.get(root.id))?.orchestrationPolicy?.budgetWarnedAt).toBeUndefined();
    await store.setRunBudget(root.id, 'run', { budgetWarnedAt: 200 }, undefined, 200);
    expect((await store.get(root.id))?.orchestrationPolicy?.budgetWarnedAt).toBe(200);
  });

  it('warns without stored values for a malformed workerTask and stays silent for a valid session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-parse-warn-'));
    const store = new SessionStore(directory, 'worker');
    const child = await store.create();
    const session = await store.get(child.id);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await new SessionStore(directory, 'worker').get(child.id);
      expect(warn).not.toHaveBeenCalled();
      await writeFile(
        join(directory, `${child.id}.json`),
        JSON.stringify({ ...session, workerTask: { version: 99, secret: 'stored-value' } })
      );
      await new SessionStore(directory, 'worker').get(child.id);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('workerTask');
      expect(warn.mock.calls[0][0]).toContain(child.id);
      expect(warn.mock.calls[0][0]).not.toContain('stored-value');
    } finally {
      warn.mockRestore();
    }
  });

  it.each([32, 31])('keeps the newest resolved decision when a task holding %i takes one more', async held => {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-task-decisions-'));
    const store = new SessionStore(directory, 'worker');
    const resolvedDecisions = Array.from({ length: held }, (_, index) => `decision-${index}`);
    const child = await store.create('worker', {
      workerTask: {
        version: 1,
        contract,
        automaticUpgrades: 0,
        resolvedDecisions,
        attempts: [{ id: 'attempt-0', model: 'worker', startedAt: '2026-11-07', trigger: 'initial' as const }],
        state: { status: 'queued' },
      },
    });
    const updated = await store.updateWorkerTask(child.id, task => ({
      ...task,
      resolvedDecisions: [...task.resolvedDecisions, 'decision-new'],
    }));
    const kept = updated?.workerTask?.resolvedDecisions;
    expect(kept).toHaveLength(32);
    expect(kept?.at(-1)).toBe('decision-new');
    expect(kept?.includes('decision-0')).toBe(held === 31);
  });

  it('loads a session stored before run attribution, then keeps a server run id through restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-run-attribution-'));
    const store = new SessionStore(directory, 'worker');
    const child = await store.create();
    const session = await store.get(child.id);
    const legacyPolicy = { rootSessionId: 'root', rootRunId: 'run-one', policy: inheritancePolicy() };
    const legacyRound = { text: 'Done', toolCallIds: [], usage: { creditsUsed: 3 } };
    await writeFile(
      join(directory, `${child.id}.json`),
      JSON.stringify({
        ...session,
        origin: { parentSessionId: 'root', depth: 1, seedPrompt: 'Brief' },
        orchestrationPolicy: legacyPolicy,
        messages: [{ id: 'm1', role: 'assistant', content: 'Done', createdAt: '2026-01-01', rounds: [legacyRound] }],
      })
    );

    const restarted = new SessionStore(directory, 'worker');
    const loaded = await restarted.get(child.id);
    expect(loaded?.orchestrationPolicy).toEqual(legacyPolicy);
    expect(loaded?.messages[0].rounds).toEqual([legacyRound]);

    expect(await restarted.setServerRunId(child.id, 'another-run', 'server-run')).toBeNull();
    await restarted.setServerRunId(child.id, 'run-one', 'server-run');
    expect((await new SessionStore(directory, 'worker').get(child.id))?.orchestrationPolicy?.serverRunId).toBe(
      'server-run'
    );
    expect(await restarted.clearServerRunId(child.id, 'run-one', 'older-run')).toBeNull();
    await restarted.clearServerRunId(child.id, 'run-one', 'server-run');
    expect((await new SessionStore(directory, 'worker').get(child.id))?.orchestrationPolicy).toEqual(legacyPolicy);
  });
});

describe('SessionStore.configure', () => {
  it('writes every named setting at once and remembers the preferences their setters remember', async () => {
    const base = await mkdtemp(join(tmpdir(), 'b4m-configure-'));
    const directory = join(base, 'sessions');
    const approvalFile = join(base, 'approval-mode.json');
    const ttlFile = join(base, 'prompt-cache-ttl.json');
    const store = new SessionStore(
      directory,
      MODEL,
      'launch-one',
      undefined,
      new ApprovalModePreference(approvalFile),
      undefined,
      new PromptCacheTtlPreference(ttlFile)
    );
    const created = await store.create();

    const summary = await store.configure(
      created.id,
      { model: 'other-model', reasoningEffort: 'high', promptCacheTtl: '1h', approvalMode: 'ask' },
      store.scopeKey()
    );

    expect(summary).toMatchObject({ model: 'other-model', reasoningEffort: 'high', promptCacheTtl: '1h' });
    const stored = await new SessionStore(directory, MODEL, 'launch-two').get(created.id);
    expect(stored).toMatchObject({
      model: 'other-model',
      reasoningEffort: 'high',
      promptCacheTtl: '1h',
      approvalMode: 'ask',
    });
    expect(await new ApprovalModePreference(approvalFile).read()).toBe('ask');
    expect(await new PromptCacheTtlPreference(ttlFile).read()).toBe('1h');
  });

  it('writes none of the settings when one of them is refused', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-configure-refused-'));
    const store = new SessionStore(directory, 'worker');
    const child = await store.create('worker', {
      workerSelection: { role: 'implementation', effectiveModel: 'worker', source: 'override', rootRunId: 'run' },
      workerTask: {
        version: 1,
        contract: {
          version: 1,
          outcome: 'Bounded task',
          rationale: 'Focused scope',
          role: 'implementation',
          paths: [],
          contextReferences: [],
          ownedChanges: [],
          coordinationConstraints: [],
          nonGoals: [],
          acceptanceCriteria: ['Observed result'],
          verification: [],
          assumptions: [],
          escalationConditions: [],
        },
        automaticUpgrades: 0,
        resolvedDecisions: [],
        attempts: [{ id: 'attempt', model: 'worker', startedAt: '2026-11-19', trigger: 'initial' }],
        state: { status: 'queued' },
      },
    });
    await store.updateWorkerTask(child.id, task => ({
      ...task,
      state: { status: 'canceled', reason: 'Canceled by user' },
    }));
    const before = await store.get(child.id);

    await expect(
      store.configure(child.id, { model: 'reviewer', reasoningEffort: 'high' }, store.scopeKey())
    ).rejects.toThrow(/Canceled/);

    const after = await new SessionStore(directory, 'worker', 'launch-two').get(child.id);
    expect(after?.model).toBe('worker');
    expect(after?.reasoningEffort).toBe(before?.reasoningEffort);
  });

  it('skips a field equal to the current value, so a worker queues no new attempt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-configure-echo-'));
    const store = new SessionStore(directory, 'worker');
    const child = await store.create('worker', {
      workerSelection: { role: 'implementation', effectiveModel: 'worker', source: 'override', rootRunId: 'run' },
      workerTask: {
        version: 1,
        contract: {
          version: 1,
          outcome: 'Bounded task',
          rationale: 'Focused scope',
          role: 'implementation',
          paths: [],
          contextReferences: [],
          ownedChanges: [],
          coordinationConstraints: [],
          nonGoals: [],
          acceptanceCriteria: ['Observed result'],
          verification: [],
          assumptions: [],
          escalationConditions: [],
        },
        automaticUpgrades: 0,
        resolvedDecisions: [],
        attempts: [{ id: 'attempt', model: 'worker', startedAt: '2026-11-19', trigger: 'initial' }],
        state: { status: 'running' },
      },
    });

    await store.configure(child.id, { model: 'worker', reasoningEffort: 'high' }, store.scopeKey());

    const after = await new SessionStore(directory, 'worker', 'launch-two').get(child.id);
    expect(after?.reasoningEffort).toBe('high');
    expect(after?.workerTask?.attempts).toHaveLength(1);
    expect(after?.workerTask?.state.status).toBe('running');
    expect(after?.workerSelection?.source).toBe('override');
  });

  it('answers null for a session that does not exist', async () => {
    const { store } = await freshStore();
    expect(await store.configure('3f0c2c55-9a43-4cf6-8d0e-1b1f0a2b3c4d', { reasoningEffort: 'high' }, null)).toBeNull();
  });
});
