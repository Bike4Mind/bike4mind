import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import { MessageQueue } from './MessageQueue';
import { git } from './project/git';
import type { AccessStore } from './tools/AccessStore';
import type { SkillCatalog } from './skills/SkillCatalog';
import type { ChatApprovalMode, ChatStreamEvent, ChatToolCall } from '@shared/chat';
import { ApprovalGate } from './tools/ApprovalGate';
import { STOP_GRACE_MS } from './tools/interruptible';

vi.mock('../git/hostGitArgs', async importOriginal =>
  (await import('./plainFolderGit.testHelper')).skipGitOutsideRepositories(await importOriginal())
);

describe('ChatService /loop', () => {
  let service: ChatService;
  let store: SessionStore;
  let streams: PassThrough[];
  let post: ReturnType<typeof vi.fn>;
  let id: string;
  let signedIn: boolean;
  let roots: string[];
  const getSkill = vi.fn();
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    signedIn = true;
    roots = [];
    streams = [];
    post = vi.fn(async () => {
      const stream = new PassThrough();
      streams.push(stream);
      return { data: stream, status: 200 };
    });
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-loop-')), 'test-model');
    getSkill
      .mockReset()
      .mockResolvedValue({ name: 'check', body: 'Check $ARGUMENTS', source: 'account', filePath: '/check' });
    service = new ChatService({
      store,
      access: { list: async () => roots } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        signedIn
          ? ({
              get: vi.fn().mockResolvedValue({}),
              getAxiosInstance: () => ({ post }),
            } as unknown as AuthenticatedApiClient)
          : null,
      getEnvironmentUrl: () => 'http://localhost:3000',
      queue: new MessageQueue(() => undefined),
      skills: { get: getSkill, forModel: async () => [], dispose: vi.fn() } as unknown as SkillCatalog,
      emit: () => undefined,
    });
    id = (await service.createSession()).id;
    await store.rename(id, 'Loop test');
  });
  afterEach(() => {
    service.dispose();
    streams.forEach(stream => stream.end());
    vi.useRealTimers();
  });

  async function waitForPosts(count: number) {
    await vi.waitFor(() => expect(post, JSON.stringify(service.getLoop(id))).toHaveBeenCalledTimes(count), {
      interval: 5,
    });
  }
  async function finish(text = 'done\nLOOP_NEXT: 1m') {
    streams
      .at(-1)
      ?.end(`data: ${JSON.stringify({ type: 'content', text, stopReason: 'end_turn' })}\n\ndata: "[DONE]"\n\n`);
    await vi.waitFor(() => expect(service.isSessionBusy(id)).toBe(false), { interval: 5 });
    await vi.waitFor(() => expect(service.getLoop(id)?.phase).not.toBe('running'), { interval: 5 });
  }

  it('runs normal turns and repeats only after completion', async () => {
    expect((await service.loopCommand(id, '30s check the job')).ok).toBe(true);
    await waitForPosts(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(post).toHaveBeenCalledTimes(1);
    await finish();
    expect(service.getLoop(id)?.phase).toBe('scheduled');
    await vi.advanceTimersByTimeAsync(30_000);
    await waitForPosts(2);
    expect(
      (await store.get(id))?.messages.filter(message => message.role === 'user').map(message => message.content)
    ).toEqual(['check the job', 'check the job']);
  });

  it('starts no run after its --until end time and ends with a notice', async () => {
    const until = new Date(Date.now() + 45_000).toISOString();
    expect(await service.loopCommand(id, `30s --until ${until} check the job`)).toMatchObject({
      ok: true,
      state: { prompt: 'check the job', until: Date.parse(until) },
    });
    await waitForPosts(1);
    await finish();
    await vi.advanceTimersByTimeAsync(30_000);
    await waitForPosts(2);
    await finish();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(post).toHaveBeenCalledTimes(2);
    expect(service.getLoop(id)).toMatchObject({ phase: 'ended', notice: expect.stringContaining('end time') });
    expect(await service.loopCommand(id, `--until ${new Date(Date.now() - 1000).toISOString()} check`)).toMatchObject({
      ok: false,
      error: expect.stringContaining('already passed'),
    });
  });

  it('uses ordinary skill expansion without sending slash text to a shell', async () => {
    await service.loopCommand(id, '30s /check the build');
    await waitForPosts(1);
    expect((await store.get(id))?.messages[0]).toMatchObject({
      content: 'Check the build',
      skill: { name: 'check', args: 'the build' },
    });
    await finish();
    getSkill.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(service.getLoop(id)?.phase).toBe('paused'), { interval: 5 });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('selects cadence from the completed model reply', async () => {
    await service.loopCommand(id, 'check the job');
    await waitForPosts(1);
    await finish('still working\nLOOP_NEXT: 3m');
    expect(service.getLoop(id)?.nextRunAt).toBeGreaterThanOrEqual(Date.now() + 179_900);
    const prompt = (await store.get(id))?.messages[0];
    expect(prompt?.notes?.join(' ')).toContain('LOOP_NEXT:');
  });

  it('waits behind an ordinary busy turn without queueing or stopping it', async () => {
    await service.send(id, 'user task');
    await waitForPosts(1);
    await service.loopCommand(id, '30s check');
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getLoop(id)?.phase).toBe('waiting');
    expect(service.queuedMessages(id)).toEqual([]);
    streams[0].end('data: {"type":"content","text":"done","stopReason":"end_turn"}\n\ndata: "[DONE]"\n\n');
    await waitForPosts(2);
  });

  it('pauses refused sends without retrying', async () => {
    signedIn = false;
    await service.loopCommand(id, '30s check');
    await vi.waitFor(() => expect(service.getLoop(id)?.phase).toBe('paused'), { interval: 5 });
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(post).not.toHaveBeenCalled();
  });

  it.each(['stop', 'archive', 'delete', 'account', 'shutdown'])('clears timers on %s', async action => {
    await service.loopCommand(id, '30s check');
    if (action === 'stop') await service.loopCommand(id, 'stop');
    if (action === 'archive') await service.setSessionArchived(id, true);
    if (action === 'delete') await service.deleteSession(id);
    if (action === 'account') service.clearLoops();
    if (action === 'shutdown') service.dispose();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(service.getLoop(id)).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('stopping a loop leaves a running turn alone and prevents recurrence', async () => {
    await service.loopCommand(id, '30s check');
    await waitForPosts(1);
    await service.loopCommand(id, 'stop');
    expect(service.isSessionBusy(id)).toBe(true);
    await finish();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('cancels a start still reading its skill', async () => {
    let resolve!: (value: unknown) => void;
    getSkill.mockImplementationOnce(
      () =>
        new Promise(value => {
          resolve = value;
        })
    );
    const starting = service.loopCommand(id, '30s /check');
    await vi.waitFor(() => expect(getSkill).toHaveBeenCalled(), { interval: 5 });
    await service.loopCommand(id, 'stop');
    resolve({ name: 'check', body: 'Check' });
    expect((await starting).ok).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(post).not.toHaveBeenCalled();
  });

  it.each(['../invalid', '', '/absolute'])('returns a friendly refusal for invalid session id %s', async sessionId => {
    await expect(service.loopCommand(sessionId, '30s check')).resolves.toEqual({
      ok: false,
      error: 'That conversation no longer exists.',
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('returns a visible refusal when reading the session fails', async () => {
    vi.spyOn(store, 'get').mockRejectedValueOnce(new Error('Permission denied'));
    await expect(service.loopCommand(id, '30s check')).resolves.toEqual({
      ok: false,
      error: 'Permission denied',
    });
    expect(service.getLoop(id)).toBeNull();
  });

  it('pauses when global shared folders change between runs', async () => {
    await service.loopCommand(id, '30s check');
    await waitForPosts(1);
    await finish();
    roots = ['/new-shared-folder'];
    service.refreshAccessScopes();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(service.getLoop(id)?.phase).toBe('paused'), { interval: 5 });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('refuses global shared folder changes during skill admission', async () => {
    const original = { name: 'check', body: 'Check', source: 'account', filePath: '/check' };
    getSkill
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(original)
      .mockImplementationOnce(async () => {
        roots = ['/new-shared-folder'];
        service.refreshAccessScopes();
        return original;
      });
    await service.loopCommand(id, '30s /check');
    await vi.waitFor(() => expect(service.getLoop(id)?.phase).toBe('paused'), { interval: 5 });
    expect(post).not.toHaveBeenCalled();
    expect((await store.get(id))?.messages).toEqual([]);
  });

  it.each(['none', 'model', 'folder'])(
    'prepares the first Code worktree while preserving context checks (changed=%s)',
    async changed => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'b4m-loop-project-')));
      await git(directory, ['init', '--initial-branch=main', '--quiet']);
      await git(directory, ['config', 'user.email', 'test@example.com']);
      await git(directory, ['config', 'user.name', 'Test']);
      await writeFile(join(directory, 'README.md'), 'Loop project\n');
      await git(directory, ['add', 'README.md']);
      await git(directory, ['commit', '--quiet', '-m', 'initial']);
      const created = await service.createCodeSession({ directory, branch: 'main', workspace: true });
      if (!created.ok) throw new Error(created.error);
      id = created.session.id;
      await store.rename(id, 'Loop worktree test');
      if (changed !== 'none') {
        const updateWorkspace = store.updateProjectWorkspace.bind(store);
        vi.spyOn(store, 'updateProjectWorkspace').mockImplementation(async (...args) => {
          const result = await updateWorkspace(...args);
          if (changed === 'model') await store.setModel(id, 'other-model');
          else await store.addContextDirectory(id, '/new-context-folder');
          return result;
        });
      }
      await service.loopCommand(id, '30s check');
      await vi.waitFor(async () => expect((await store.get(id))?.project?.workingDirectory).not.toBe(directory), {
        interval: 5,
      });
      if (changed !== 'none') {
        await vi.waitFor(() => expect(service.getLoop(id)?.phase).toBe('paused'), { interval: 5 });
        expect(post).not.toHaveBeenCalled();
        expect((await store.get(id))?.messages).toEqual([]);
        return;
      }
      await waitForPosts(1);
      await finish();
      const project = (await store.get(id))?.project;
      expect(project?.workspaceBranch).toMatch(/^b4m\//);
      await vi.advanceTimersByTimeAsync(30_000);
      await waitForPosts(2);
      expect((await store.get(id))?.project).toEqual(project);
    }
  );

  it('refuses a skill that changes between validation and turn admission', async () => {
    const original = { name: 'check', body: 'Check', source: 'account', filePath: '/check' };
    getSkill
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(original)
      .mockResolvedValue({ ...original, body: 'Changed' });
    await service.loopCommand(id, '30s /check');
    await vi.waitFor(() => expect(service.getLoop(id)?.phase).toBe('paused'), { interval: 5 });
    expect(post).not.toHaveBeenCalled();
    expect((await store.get(id))?.messages).toEqual([]);
  });

  it('refuses context changes while a skill is being admitted', async () => {
    const original = { name: 'check', body: 'Check', source: 'account', filePath: '/check' };
    getSkill
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(original)
      .mockImplementationOnce(async () => {
        await store.setModel(id, 'other-model');
        return original;
      });
    await service.loopCommand(id, '30s /check');
    await vi.waitFor(() => expect(service.getLoop(id)?.phase).toBe('paused'), { interval: 5 });
    expect(post).not.toHaveBeenCalled();
    expect((await store.get(id))?.messages).toEqual([]);
  });
});

describe('loopTool', () => {
  function frame(payload: unknown): string {
    return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
  }

  function toolTurn(id: string, input: Record<string, unknown>): string {
    return frame({ type: 'tool_use', tools: [{ id, name: 'loop', arguments: JSON.stringify(input) }] });
  }

  const DONE = `${frame({ type: 'content', text: 'done', stopReason: 'end_turn' })}${frame('[DONE]')}`;

  describe('ChatService loop tool', () => {
    let store: SessionStore;
    let service: ChatService;
    let approvals: ApprovalGate;
    let events: ChatStreamEvent[];
    let streams: PassThrough[];
    let id: string;
    const getSkill = vi.fn();

    const call = (callId: string, status: ChatToolCall['status']) =>
      events
        .map(event => (event.type === 'tool-start' || event.type === 'tool-end' ? event.call : null))
        .find(entry => entry?.id === callId && entry.status === status);

    const settled = (callId: string) =>
      vi.waitUntil(
        () => events.map(event => (event.type === 'tool-end' ? event.call : null)).find(entry => entry?.id === callId),
        { timeout: 5000, interval: 5 }
      );

    async function startTurn(mode: ChatApprovalMode): Promise<void> {
      await service.setApprovalMode(id, mode);
      await service.send(id, 'go');
      await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
    }

    beforeEach(async () => {
      store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-loop-tool-')), 'test-model');
      approvals = new ApprovalGate();
      getSkill.mockReset().mockResolvedValue({ name: 'check', body: 'Check', source: 'account', filePath: '/check' });
      const testEvents: ChatStreamEvent[] = [];
      const testStreams: PassThrough[] = [];
      events = testEvents;
      streams = testStreams;
      const post = vi.fn(async () => {
        const stream = new PassThrough();
        testStreams.push(stream);
        return { data: stream, status: 200 };
      });
      service = new ChatService({
        store,
        access: { list: async () => [] } as unknown as AccessStore,
        approvals,
        queue: new MessageQueue(() => undefined),
        skills: { get: getSkill, forModel: async () => [], dispose: vi.fn() } as unknown as SkillCatalog,
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: () =>
          ({
            get: vi.fn().mockResolvedValue({}),
            getAxiosInstance: () => ({ post }),
          }) as unknown as AuthenticatedApiClient,
        getEnvironmentUrl: () => 'http://localhost:3000',
        emit: event => testEvents.push(event),
      });
      id = (await service.createSession()).id;
      await store.rename(id, 'Loop tool test');
    });

    afterEach(() => {
      service.dispose();
      for (const stream of streams) stream.end();
      vi.restoreAllMocks();
    });

    it.each(['ask', 'auto'] as const)(
      'asks before starting a loop in %s mode, showing prompt, interval and end',
      async mode => {
        await startTurn(mode);
        const until = new Date(Date.now() + 3_600_000).toISOString();
        streams[0].write(toolTurn('c1', { action: 'start', prompt: 'tell me the time', interval: '1m', until }));
        streams[0].write(frame('[DONE]'));
        const asked = await vi.waitUntil(() => call('c1', 'awaiting-approval'), { timeout: 5000, interval: 5 });
        expect(asked.approvalDetail).toContain('Prompt: tell me the time');
        expect(asked.approvalDetail).toContain('Interval: 1m after each run completes');
        expect(asked.approvalDetail).toMatch(/Until: \S/);
        expect(asked.approvalOnceOnly).toBe(true);
        expect(service.getLoop(id)).toBeNull();

        approvals.resolve(asked.approvalId as string, { decision: 'once' });
        expect((await settled('c1')).status).toBe('done');
        expect(service.getLoop(id)).toMatchObject({
          prompt: 'tell me the time',
          intervalMs: 60_000,
          until: Date.parse(until),
        });
      }
    );

    it('starts unasked in full mode, through the same path as /loop', async () => {
      await startTurn('full');
      streams[0].write(toolTurn('c1', { action: 'start', prompt: 'check the build' }));
      streams[0].write(frame('[DONE]'));
      const done = await settled('c1');
      expect(done.status).toBe('done');
      expect(call('c1', 'awaiting-approval')).toBeUndefined();
      expect(done.preview).toContain('Loop started');
      expect(service.getLoop(id)).toMatchObject({ prompt: 'check the build', intervalMs: null });
      expect(await service.loopCommand(id, 'list')).toMatchObject({ ok: true, state: { prompt: 'check the build' } });

      await vi.waitUntil(() => streams.length === 2, { timeout: 5000, interval: 5 });
      streams[1].write(DONE);
      await vi.waitUntil(() => streams.length === 3, { timeout: 5000, interval: 5 });
      const messages = (await store.get(id))?.messages.filter(message => message.role === 'user');
      expect(messages?.at(-1)).toMatchObject({ content: 'check the build' });
      await service.loopCommand(id, 'stop');
      expect(service.getLoop(id)).toBeNull();
    });

    it('lists and stops without asking, even in ask mode', async () => {
      await startTurn('ask');
      await service.loopCommand(id, '1h check');
      streams[0].write(toolTurn('c1', { action: 'list' }));
      streams[0].write(toolTurn('c2', { action: 'stop' }));
      streams[0].write(frame('[DONE]'));
      expect((await settled('c1')).preview).toContain('Prompt: check');
      expect((await settled('c2')).preview).toContain('Loop stopped');
      expect(call('c1', 'awaiting-approval') ?? call('c2', 'awaiting-approval')).toBeUndefined();
      expect(service.getLoop(id)).toBeNull();
    });

    it('refuses an end time in the past without a card', async () => {
      await startTurn('ask');
      const until = new Date(Date.now() - 60_000).toISOString();
      streams[0].write(toolTurn('c1', { action: 'start', prompt: 'check', until }));
      streams[0].write(frame('[DONE]'));
      const refused = await settled('c1');
      expect(refused.status).toBe('error');
      expect(refused.error).toContain('already passed');
      expect(call('c1', 'awaiting-approval')).toBeUndefined();
      expect(service.getLoop(id)).toBeNull();
    });

    it('refuses to start a loop from inside a loop run', async () => {
      await service.setApprovalMode(id, 'full');
      await service.loopCommand(id, '1h check');
      await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
      expect(service.getLoop(id)?.phase).toBe('running');
      streams[0].write(toolTurn('c1', { action: 'start', prompt: 'nested', interval: '30s' }));
      streams[0].write(frame('[DONE]'));
      const refused = await settled('c1');
      expect(refused.status).toBe('error');
      expect(refused.error).toContain('cannot start another loop');
      expect(service.getLoop(id)?.prompt).toBe('check');
    });
    it.each(['tool', 'user'] as const)('retains loop origin after its schedule is stopped by the %s', async stopper => {
      await service.setApprovalMode(id, 'full');
      await service.loopCommand(id, '1h check');
      await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
      if (stopper === 'tool') {
        streams[0].write(toolTurn('stop-loop', { action: 'stop' }));
        streams[0].write(frame('[DONE]'));
        expect((await settled('stop-loop')).status).toBe('done');
        await vi.waitUntil(() => streams.length === 2, { timeout: 5000, interval: 5 });
      } else {
        await service.loopCommand(id, 'stop');
      }
      expect(service.getLoop(id)).toBeNull();
      const current = streams.length - 1;
      streams[current].write(toolTurn('nested-after-stop', { action: 'start', prompt: 'nested', interval: '30s' }));
      streams[current].write(frame('[DONE]'));
      const refused = await settled('nested-after-stop');
      expect(refused.status).toBe('error');
      expect(refused.error).toContain('cannot start another loop');
      expect(call('nested-after-stop', 'awaiting-approval')).toBeUndefined();
      expect(service.getLoop(id)).toBeNull();
      expect(
        (await store.get(id))?.messages.filter(message => message.role === 'user' && message.content === 'check')
      ).toHaveLength(1);
    });

    it('does not install an abandoned start after Send now interrupts skill preparation', async () => {
      await startTurn('full');
      const skill = { name: 'check', body: 'Check', source: 'account', filePath: '/check' };
      let release: ((value: typeof skill) => void) | undefined;
      const preparation = new Promise<typeof skill>(resolve => {
        release = resolve;
      });
      getSkill.mockImplementationOnce(() => preparation);
      streams[0].write(toolTurn('late-start', { action: 'start', prompt: '/check', interval: '1h' }));
      streams[0].write(frame('[DONE]'));
      await vi.waitUntil(() => getSkill.mock.calls.length > 0, { timeout: 5000, interval: 5 });
      const queued = await service.send(id, 'Send this instead');
      if (!queued.ok || !queued.queued) throw new Error('Expected queued user message');
      // The grace a stopped call gets is run out rather than waited for.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        service.sendQueuedNow(id, queued.message.id);
        await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
      } finally {
        vi.useRealTimers();
      }
      await vi.waitUntil(() => streams.length === 2, { timeout: 5000, interval: 5 });
      if (!release) throw new Error('Missing skill preparation barrier');
      release(skill);
      await preparation;
      expect(service.getLoop(id)).toBeNull();
      streams[1].write(DONE);
      await vi.waitUntil(() => !service.isSessionBusy(id), { timeout: 5000, interval: 5 });
      expect(service.getLoop(id)).toBeNull();
      expect(streams).toHaveLength(2);
    });

    it.each([false, true])(
      'binds clock approval to its original absolute deadline across midnight=%s',
      async crossesMidnight => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 10, 12, 23, 56).getTime());
        await startTurn('ask');
        streams[0].write(toolTurn('clock-start', { action: 'start', prompt: 'check', interval: '1h', until: '23:59' }));
        streams[0].write(frame('[DONE]'));
        const asked = await vi.waitUntil(() => call('clock-start', 'awaiting-approval'), {
          timeout: 5000,
          interval: 5,
        });
        clock.mockReturnValue(
          crossesMidnight ? new Date(2026, 10, 13, 0, 0).getTime() : new Date(2026, 10, 12, 23, 58).getTime()
        );
        approvals.resolve(asked.approvalId as string, { decision: 'once' });
        const result = await settled('clock-start');
        if (crossesMidnight) {
          expect(result.status).toBe('error');
          expect(result.error).toContain('changed after approval');
          expect(service.getLoop(id)).toBeNull();
        } else {
          expect(result.status).toBe('done');
          expect(service.getLoop(id)?.until).toBe(new Date(2026, 10, 12, 23, 59).getTime());
        }
      }
    );
  });
});
