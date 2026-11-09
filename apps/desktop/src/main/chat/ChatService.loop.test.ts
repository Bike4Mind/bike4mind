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
    await vi.waitFor(() => expect(post, JSON.stringify(service.getLoop(id))).toHaveBeenCalledTimes(count));
  }
  async function finish(text = 'done\nLOOP_NEXT: 1m') {
    streams
      .at(-1)
      ?.end(`data: ${JSON.stringify({ type: 'content', text, stopReason: 'end_turn' })}\n\ndata: "[DONE]"\n\n`);
    await vi.waitFor(() => expect(service.isSessionBusy(id)).toBe(false));
    await vi.waitFor(() => expect(service.getLoop(id)?.phase).not.toBe('running'));
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
    await vi.waitFor(() => expect(service.getLoop(id)?.phase).toBe('paused'));
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
    await vi.waitFor(() => expect(service.getLoop(id)?.phase).toBe('paused'));
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
    await vi.waitFor(() => expect(getSkill).toHaveBeenCalled());
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
    await vi.waitFor(() => expect(service.getLoop(id)?.phase).toBe('paused'));
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
    await vi.waitFor(() => expect(service.getLoop(id)?.phase).toBe('paused'));
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
      await vi.waitFor(async () => expect((await store.get(id))?.project?.workingDirectory).not.toBe(directory));
      if (changed !== 'none') {
        await vi.waitFor(() => expect(service.getLoop(id)?.phase).toBe('paused'));
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
    await vi.waitFor(() => expect(service.getLoop(id)?.phase).toBe('paused'));
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
    await vi.waitFor(() => expect(service.getLoop(id)?.phase).toBe('paused'));
    expect(post).not.toHaveBeenCalled();
    expect((await store.get(id))?.messages).toEqual([]);
  });
});
