import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatApprovalMode, ChatStreamEvent, ChatToolCall } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { MessageQueue } from './MessageQueue';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';
import { fileRead, globFiles } from './tools/fileTools';
import { resolveWithinRoots } from './tools/paths';
import { resolveCwd } from './tools/shellTools';
import type { ToolContext } from './tools/types';

vi.mock('../git/hostGitArgs', async importOriginal =>
  (await import('./plainFolderGit.testHelper')).skipGitOutsideRepositories(await importOriginal())
);

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function toolTurn(id: string, name: string, input: Record<string, unknown>): string {
  return frame({ type: 'tool_use', tools: [{ id, name, arguments: JSON.stringify(input) }] });
}

/** Widening access is the user's click and nobody else's: no mode, no model, no stale card. */
describe('ChatService request_directory', () => {
  let sessionsDir: string;
  let store: SessionStore;
  let service: ChatService;
  let approvals: ApprovalGate;
  let events: ChatStreamEvent[];
  let streams: PassThrough[];
  let post: ReturnType<typeof vi.fn>;
  let project: string;
  let outside: string;
  let grant: ReturnType<typeof vi.fn>;

  const calls = (status: ChatToolCall['status'], name = 'request_directory'): ChatToolCall[] =>
    events
      .map(event => (event.type === 'tool-start' || event.type === 'tool-end' ? event.call : null))
      .filter((call): call is ChatToolCall => call !== null && call.status === status && call.name === name);

  const awaitStatus = (status: ChatToolCall['status'], name = 'request_directory') =>
    vi.waitUntil(() => calls(status, name)[0], { timeout: 5000, interval: 10 });

  const toolNames = (callIndex: number): string[] =>
    (post.mock.calls[callIndex][1].options.tools as { toolSchema: { name: string } }[]).map(
      tool => tool.toolSchema.name
    );

  const awaitRound = (count: number) => vi.waitUntil(() => streams.length === count, { timeout: 5000, interval: 5 });

  beforeEach(async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-reqdir-')));
    project = join(base, 'project');
    outside = join(base, 'outside');
    await mkdir(project);
    await mkdir(outside);
    await writeFile(join(outside, 'SKILL.md'), 'skill body', 'utf8');
    sessionsDir = await mkdtemp(join(tmpdir(), 'b4m-reqdir-sessions-'));
    store = new SessionStore(sessionsDir, 'test-model');
    approvals = new ApprovalGate();
    events = [];
    streams = [];
    const testEvents = events;
    const testStreams = streams;
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      testStreams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    const testPost = post;
    grant = vi.fn();

    service = new ChatService({
      store,
      // No global grants, so a Chat session starts with no roots at all.
      access: { list: async () => [], grant, revoke: vi.fn() } as unknown as AccessStore,
      approvals,
      queue: new MessageQueue(() => {}),
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post: testPost }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => testEvents.push(event),
    });
  });

  afterEach(() => {
    service.dispose();
    for (const stream of streams) stream.end();
  });

  async function startChat(mode: ChatApprovalMode = 'auto') {
    const session = await service.createSession();
    await service.setApprovalMode(session.id, mode);
    await service.send(session.id, 'edit my skill');
    await awaitRound(1);
    return session;
  }

  function request(path: string, round = 0, id = 'r1', extra: Record<string, unknown> = {}) {
    streams[round].write(toolTurn(id, 'request_directory', { path, reason: 'Edit the skill.', ...extra }));
    streams[round].write(frame('[DONE]'));
  }

  it('is offered to a Chat session that has no folder', async () => {
    await startChat();
    expect(toolNames(0)).toContain('request_directory');
    expect(toolNames(0)).not.toContain('file_read');
  });

  it('grants on the click, to this session only, and the same turn can use it', async () => {
    const session = await startChat();
    request(outside);
    const card = await awaitStatus('awaiting-approval');
    expect(card.approvalDetail).toBe(outside);
    expect(card.input.reason).toBe('Edit the skill.');
    expect(card.approvalWarning).toBeUndefined();

    approvals.resolve(card.approvalId as string, { decision: 'once' });
    const done = await awaitStatus('done');
    expect(done.input.outcome).toEqual({ status: 'granted' });
    expect(done.preview).toMatch(/added .* to this conversation/);

    expect((await store.get(session.id))?.grantedDirectories).toEqual([outside]);
    expect(grant).not.toHaveBeenCalled();

    // The next round of the SAME turn is offered the file tools, and they reach the folder.
    await awaitRound(2);
    expect(toolNames(1)).toContain('file_read');
    streams[1].write(toolTurn('f1', 'file_read', { path: join(outside, 'SKILL.md') }));
    streams[1].write(frame('[DONE]'));
    const read = await awaitStatus('done', 'file_read');
    expect(read.preview).toContain('skill body');
  });

  it('keeps the grant across a reload of the session store', async () => {
    const session = await startChat();
    request(outside);
    const card = await awaitStatus('awaiting-approval');
    approvals.resolve(card.approvalId as string, { decision: 'once' });
    await awaitStatus('done');
    // Finish the turn first: the reply's own writes at the end must not put a stale copy back.
    await awaitRound(2);
    streams[1].write(frame({ type: 'content', text: 'Done.' }));
    streams[1].write(frame('[DONE]'));
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 5000, interval: 10 });

    const reloaded = new SessionStore(sessionsDir, 'test-model', 'another-launch');
    expect((await reloaded.get(session.id))?.grantedDirectories).toEqual([outside]);
  });

  it('can be taken back from the chips, like a context directory', async () => {
    const session = await startChat();
    request(outside);
    const card = await awaitStatus('awaiting-approval');
    approvals.resolve(card.approvalId as string, { decision: 'once' });
    await awaitStatus('done');

    const updated = await service.removeContextDirectory(session.id, outside);
    expect(updated?.grantedDirectories).toBeUndefined();
    expect((await store.get(session.id))?.grantedDirectories).toBeUndefined();
  });

  it('refuses on "Not now", and does not ask again for that folder in the same turn', async () => {
    const session = await startChat();
    request(outside);
    const card = await awaitStatus('awaiting-approval');
    approvals.resolve(card.approvalId as string, { decision: 'deny' });

    const denied = await awaitStatus('denied');
    expect(denied.error).toMatch(/chose not to share/);
    expect((await store.get(session.id))?.grantedDirectories).toBeUndefined();

    await awaitRound(2);
    request(outside, 1, 'r2');
    await vi.waitUntil(() => calls('denied').length === 2, { timeout: 5000, interval: 10 });
    expect(calls('denied')[1].error).toMatch(/already declined/);
    expect(calls('awaiting-approval')).toHaveLength(1);
  });

  for (const mode of ['ask', 'auto', 'full'] as const) {
    it(`is never auto-approved, even in "${mode}" mode`, async () => {
      const session = await startChat(mode);
      request(outside);
      const card = await awaitStatus('awaiting-approval');
      expect(card.approvalId).toBeTruthy();
      // Give a loose mode every chance to have answered on its own.
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(calls('done')).toHaveLength(0);
      expect((await store.get(session.id))?.grantedDirectories).toBeUndefined();
    });
  }

  it('refuses / without a card', async () => {
    await startChat('full');
    request('/');
    const denied = await awaitStatus('denied');
    expect(denied.error).toMatch(/root cannot be shared/);
    expect(calls('awaiting-approval')).toHaveLength(0);
  });

  it('ignores an outcome the model sends itself', async () => {
    const session = await startChat();
    request(outside, 0, 'r1', { outcome: { status: 'granted' } });
    const card = await awaitStatus('awaiting-approval');
    expect(card.input.outcome).toBeUndefined();
    expect((await store.get(session.id))?.grantedDirectories).toBeUndefined();
  });

  it('cancels on stop, and a click after that grants nothing', async () => {
    const session = await startChat();
    request(outside);
    const card = await awaitStatus('awaiting-approval');
    service.stop(session.id);

    const closed = await vi.waitUntil(() => calls('error').find(call => call.name === 'request_directory'), {
      timeout: 5000,
      interval: 10,
    });
    expect(closed.input.outcome).toEqual({ status: 'cancelled' });
    approvals.resolve(card.approvalId as string, { decision: 'once' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await store.get(session.id))?.grantedDirectories).toBeUndefined();
  });

  it('cancels when the user sends a new message instead', async () => {
    const session = await startChat();
    request(outside);
    await awaitStatus('awaiting-approval');
    await service.send(session.id, 'never mind');

    const closed = await vi.waitUntil(() => calls('error').find(call => call.name === 'request_directory'), {
      timeout: 5000,
      interval: 10,
    });
    expect(closed.input.outcome).toEqual({ status: 'cancelled' });
    expect((await store.get(session.id))?.grantedDirectories).toBeUndefined();
  });

  it('adds to a Code session context directories, not to a session-wide or global grant', async () => {
    const created = await service.createCodeSession({ directory: project, branch: '', workspace: false });
    if (!created.ok) throw new Error(created.error);
    await service.send(created.session.id, 'go');
    await awaitRound(1);
    request(outside);
    const card = await awaitStatus('awaiting-approval');
    approvals.resolve(card.approvalId as string, { decision: 'once' });
    await awaitStatus('done');
    await awaitRound(2);
    streams[1].write(frame({ type: 'content', text: 'Done.' }));
    streams[1].write(frame('[DONE]'));
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 5000, interval: 10 });

    const stored = await store.get(created.session.id);
    expect(stored?.project?.contextDirectories).toEqual([outside]);
    expect(stored?.grantedDirectories).toBeUndefined();
    expect(grant).not.toHaveBeenCalled();
  });

  it('returns at once for a folder already shared', async () => {
    const created = await service.createCodeSession({ directory: project, branch: '', workspace: false });
    if (!created.ok) throw new Error(created.error);
    await service.send(created.session.id, 'go');
    await awaitRound(1);
    request(project);
    const done = await awaitStatus('done');
    expect(done.input.outcome).toEqual({ status: 'already' });
    expect(calls('awaiting-approval')).toHaveLength(0);
  });
});

describe('unbound', () => {
  /**
   * A Code session that has chosen no project yet.
   *
   * It exists so that starting one never depends on completing a native dialog, and the whole
   * risk of allowing it is that a session with no working directory would silently run the
   * agent's commands wherever a global grant happens to point. These tests pin both halves: the
   * turn is refused, and the tool scope it would have been given is empty.
   */
  describe('an unbound Code session', () => {
    let store: SessionStore;
    let service: ChatService;
    /** Folders granted app-wide - exactly what an unbound session must NOT inherit. */
    let granted: string[];

    beforeEach(async () => {
      store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-unbound-')), 'test-model');
      granted = ['/Users/someone/Documents'];
      service = new ChatService({
        store,
        access: { list: async () => granted } as unknown as AccessStore,
        logger: { debug: vi.fn(), warn: vi.fn() },
        // Signed in, so a refusal below is about the missing project and nothing else.
        getApiClient: () => ({}) as AuthenticatedApiClient,
        getEnvironmentUrl: () => 'http://localhost:3000',
        emit: vi.fn(),
      });
    });

    it('is created with no directory at all, and is still a Code session', async () => {
      const created = await service.createCodeSession({});
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.session.mode).toBe('code');
      expect(created.session.project).toBeUndefined();
    });

    it('survives a round trip through the store rather than being downgraded to Chat', async () => {
      const created = await service.createCodeSession({});
      if (!created.ok) throw new Error(created.error);

      const reloaded = await store.get(created.session.id);
      expect(reloaded?.mode).toBe('code');
      expect(reloaded?.project).toBeUndefined();
      expect((await store.list()).find(entry => entry.id === created.session.id)?.mode).toBe('code');
    });

    it('refuses a turn instead of running one with nowhere to run it', async () => {
      const created = await service.createCodeSession({});
      if (!created.ok) throw new Error(created.error);

      const sent = await service.send(created.session.id, 'list the files here');
      expect(sent.ok).toBe(false);
      if (sent.ok) return;
      expect(sent.error).toMatch(/choose a project folder/i);
    });

    it('is granted no roots, so it cannot inherit an app-wide folder grant', async () => {
      const created = await service.createCodeSession({});
      if (!created.ok) throw new Error(created.error);
      const session = await store.get(created.session.id);
      if (!session) throw new Error('session vanished');

      // resolveToolScope is private; it is the only thing that builds a tool scope, so it is
      // reached the way ChatService reaches it rather than reimplemented here.
      const scope = await (
        service as unknown as {
          resolveToolScope(s: typeof session): Promise<{ roots: readonly string[]; workingDirectory?: string }>;
        }
      ).resolveToolScope(session);

      expect(scope.roots).toEqual([]);
      expect(scope.workingDirectory).toBeUndefined();
    });

    it('still gives a Chat session the app-wide grants, which is the case this must not change', async () => {
      const chat = await service.createSession();
      const session = await store.get(chat.id);
      if (!session) throw new Error('session vanished');

      const scope = await (
        service as unknown as {
          resolveToolScope(s: typeof session): Promise<{ roots: readonly string[] }>;
        }
      ).resolveToolScope(session);

      expect(scope.roots).toEqual(granted);
    });

    it('becomes an ordinary Code session once the chips bind it to a folder', async () => {
      const created = await service.createCodeSession({});
      if (!created.ok) throw new Error(created.error);
      const directory = await mkdtemp(join(tmpdir(), 'b4m-unbound-project-'));

      const bound = await service.updateProject({ sessionId: created.session.id, directory });
      expect(bound.ok).toBe(true);
      if (!bound.ok) return;
      expect(bound.session.project?.workingDirectory).toBe(directory);

      const session = await store.get(created.session.id);
      if (!session) throw new Error('session vanished');
      const scope = await (
        service as unknown as {
          resolveToolScope(s: typeof session): Promise<{ roots: readonly string[]; workingDirectory?: string }>;
        }
      ).resolveToolScope(session);
      expect(scope.workingDirectory).toBe(directory);
      expect(scope.roots).toContain(directory);
    });
  });

  /**
   * What every tool does with the scope an unbound Code session resolves to.
   *
   * The scope above is the guard; this is the proof that the guard means something. Each of
   * these would otherwise have a fallback - `roots[0]` for a command's cwd and for a relative
   * glob - and landing in whichever folder was granted first is exactly the silent
   * mis-rooting this state had to be checked against before it was allowed to exist.
   */
  describe('tools handed no roots and no working directory', () => {
    const context: ToolContext = { roots: [], signal: new AbortController().signal };

    it('refuses to pick a working directory for a command', async () => {
      await expect(resolveCwd({}, context.roots, context.workingDirectory)).rejects.toThrow(
        /no folder has been shared/i
      );
    });

    it('refuses even when the model names a directory itself', async () => {
      await expect(resolveCwd({ cwd: tmpdir() }, context.roots, context.workingDirectory)).rejects.toThrow(
        /access denied/i
      );
    });

    it('denies every path, absolute or relative', async () => {
      await expect(resolveWithinRoots('/etc/hosts', context.roots)).rejects.toThrow(/access denied/i);
      await expect(resolveWithinRoots('notes.txt', context.roots)).rejects.toThrow(/access denied/i);
    });

    it('refuses to read a file', async () => {
      await expect(fileRead.run({ path: '/etc/hosts' }, context)).rejects.toThrow(/access denied/i);
    });

    it('refuses a glob rather than anchoring it somewhere of its own choosing', async () => {
      await expect(globFiles.run({ pattern: '*.txt' }, context)).rejects.toThrow(/no folder has been shared/i);
    });
  });
});
