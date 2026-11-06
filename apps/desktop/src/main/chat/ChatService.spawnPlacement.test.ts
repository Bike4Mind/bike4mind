import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import {
  awaitsWorktree,
  type BackgroundProcessInfo,
  type ChatSessionSummary,
  type ChatSpawnSuggestion,
  type ChatStreamEvent,
  type ChatQueueEvent,
} from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService, MAX_CONCURRENT_SPAWNED } from './ChatService';
import { SessionStore } from './SessionStore';
import { AttachmentStore } from './AttachmentStore';
import { MessageQueue } from './MessageQueue';
import { git, listWorktrees } from './project/git';
import { appWorktreeRoot, prefetchBase, releaseBranchName, reserveBranchName } from './project/workspace';
import { DependencyInstaller } from './project/dependencyInstall';
import { BackgroundProcessRegistry } from './tools/BackgroundProcessRegistry';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';

// The real resolveWorkspace behind a gate, so a test can hold the worktree mid-cut and look at what
// the session is meanwhile. Open by default.
const gate = vi.hoisted(() => ({ hold: Promise.resolve(), fail: null as Error | null }));
vi.mock('./project/workspace', async importOriginal => {
  const actual = await importOriginal<typeof import('./project/workspace')>();
  return {
    ...actual,
    prefetchBase: vi.fn(actual.prefetchBase),
    resolveWorkspace: async (...args: Parameters<typeof actual.resolveWorkspace>) => {
      await gate.hold;
      if (gate.fail) throw gate.fail;
      return actual.resolveWorkspace(...args);
    },
  };
});

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

/**
 * Where a spawned session's tools run, which the USER picks on the suggestion card.
 *
 * A real repository in the user's container layout underneath, because what is being tested is
 * whether a checkout is actually made and where - stubbing resolveWorkspace would assert only
 * that this code calls the code it calls.
 *
 * Its own file rather than ChatService.spawn.test.ts because that one states, and depends on,
 * the caps holding against a model that ignores them. Here the model only suggests; the choice is
 * made when the test starts the suggestion, as the card does, so what is under test is the
 * placement that start produces.
 */
describe('ChatService spawn placement', () => {
  let store: SessionStore;
  let service: ChatService;
  let events: ChatStreamEvent[];
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];
  let container: string;
  let main: string;
  let queue: MessageQueue;
  let dependencies: DependencyInstaller;
  let attachments: AttachmentStore;
  let queueEvents: ChatQueueEvent[];

  /** A repository in the user's layout: a bare dir plus one folder per branch beside it. */
  async function repository(): Promise<void> {
    // realpath because on macOS tmpdir() is a symlink into /private and git reports resolved paths.
    const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-place-')));
    const source = join(root, 'source');
    await mkdir(source, { recursive: true });
    await git(source, ['init', '--initial-branch=main', '--quiet']);
    await git(source, ['config', 'user.email', 'test@example.com']);
    await git(source, ['config', 'user.name', 'Test']);
    await writeFile(join(source, 'README.md'), 'hello\n', 'utf8');
    await git(source, ['add', '.']);
    await git(source, ['commit', '--quiet', '-m', 'first']);

    container = join(root, 'project');
    await mkdir(container, { recursive: true });
    await git(container, ['clone', '--bare', '--quiet', source, '.bare']);
    main = join(container, 'main');
    await git(join(container, '.bare'), ['worktree', 'add', '--quiet', main, 'main']);
  }

  beforeEach(async () => {
    vi.mocked(prefetchBase).mockClear();
    gate.hold = Promise.resolve();
    gate.fail = null;
    await repository();
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-place-sessions-')), 'test-model');
    // Bound per test: a previous service replying late must not push into this test's events.
    const emitted: ChatStreamEvent[] = [];
    events = emitted;
    const opened: PassThrough[] = [];
    streams = opened;
    const boundPost = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      opened.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    post = boundPost;
    queueEvents = [];
    queue = new MessageQueue(event => queueEvents.push(event));
    attachments = new AttachmentStore(await mkdtemp(join(tmpdir(), 'b4m-place-attachments-')), {
      debug: vi.fn(),
      warn: vi.fn(),
    });
    dependencies = new DependencyInstaller(new BackgroundProcessRegistry({ output: () => {}, status: () => {} }));
    vi.spyOn(dependencies, 'maybeStart').mockResolvedValue(undefined);

    service = new ChatService({
      store,
      queue,
      attachments,
      dependencies,
      approvals: new ApprovalGate(),
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post: boundPost }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => emitted.push(event),
    });
  });

  afterEach(() => {
    // Children are left mid-reply, so they have to be released or the run does not end.
    service.dispose();
    for (const stream of streams) stream.end();
  });

  async function parentSession(): Promise<ChatSessionSummary> {
    const created = await service.createCodeSession({ directory: main, branch: 'main', workspace: false });
    if (!created.ok) throw new Error(created.error);
    return created.session;
  }

  /** Ask for one spawn, the way a model does. */
  function requestSpawn(stream: PassThrough, id: string, prompt: string, title: string): void {
    stream.write(
      frame({
        type: 'tool_use',
        tools: [{ id, name: 'session_spawn', arguments: JSON.stringify({ prompt, title }) }],
      })
    );
    stream.write(frame('[DONE]'));
  }

  /** The newest pending suggestion the card would show, once the model's request has recorded it. */
  function awaitSuggestion(): Promise<ChatSpawnSuggestion> {
    return vi.waitUntil(
      () => {
        for (let index = events.length - 1; index >= 0; index--) {
          const event = events[index];
          if (event.type !== 'spawn-suggestions') continue;
          return event.suggestions.find(entry => entry.status === 'pending');
        }
        return undefined;
      },
      { timeout: 5000, interval: 5 }
    );
  }

  function settled() {
    return events
      .filter(event => event.type === 'tool-end')
      .map(event => (event.type === 'tool-end' ? event.call : null))
      .filter(call => call?.name === 'session_spawn');
  }

  async function relayFromParent(parentId: string, targetId: string, text: string) {
    await store.setApprovalMode(parentId, 'auto');
    const stream = await vi.waitUntil(() => streams[1], { timeout: 5000, interval: 5 });
    stream.write(
      frame({
        type: 'tool_use',
        tools: [
          {
            id: 'relay-input',
            name: 'session_send',
            arguments: JSON.stringify({ session_id: targetId, message: text }),
          },
        ],
      })
    );
    stream.write(frame('[DONE]'));
    const ended = await vi.waitUntil(
      () => events.find(event => event.type === 'tool-end' && event.call.id === 'relay-input'),
      { timeout: 5000, interval: 5 }
    );
    if (ended.type !== 'tool-end') throw new Error('Relay did not settle');
    return ended.call;
  }

  function awaitSettled(count: number) {
    return vi.waitUntil(() => settled().length >= count, { timeout: 5000, interval: 5 });
  }

  type Choice = { placement: 'worktree'; branch: string } | { placement: 'local' };

  /** The model's request through to the suggestion it leaves on the card; nothing has started. */
  async function suggest(
    task: { prompt: string; title: string } = { prompt: 'do the thing', title: 'The thing' }
  ): Promise<ChatSpawnSuggestion> {
    requestSpawn(streams[0], 'call-1', task.prompt, task.title);
    const suggestion = await awaitSuggestion();
    await awaitSettled(1);
    return suggestion;
  }

  /** Start a suggestion the way the card does, with the text the model gave unless edited. */
  function start(parent: ChatSessionSummary, suggestion: ChatSpawnSuggestion, choice: Choice) {
    return service.startSpawnSuggestion({
      sessionId: parent.id,
      suggestionId: suggestion.id,
      prompt: suggestion.prompt,
      title: suggestion.title,
      ...choice,
    });
  }

  /** A parent with a turn open, the model's request for one task, and the user's start of it. */
  async function spawnWith(
    choice: Choice,
    task: { prompt: string; title: string } = { prompt: 'do the thing', title: 'The thing' }
  ) {
    const parent = await parentSession();
    await service.send(parent.id, 'go');
    await vi.waitUntil(() => streams.length > 0, { timeout: 5000, interval: 5 });
    const suggestion = await suggest(task);
    const result = await start(parent, suggestion, choice);
    return { parent, suggestion, result };
  }

  /** The rest of spawnWith, for a parent a test has already set up and started a turn on. */
  async function startOn(parent: ChatSessionSummary, choice: Choice) {
    const suggestion = await suggest();
    return { suggestion, result: await start(parent, suggestion, choice) };
  }

  async function commit(directory: string, file: string): Promise<string> {
    await git(directory, ['config', 'user.email', 'test@example.com']);
    await git(directory, ['config', 'user.name', 'Test']);
    await writeFile(join(directory, file), `${file}\n`, 'utf8');
    await git(directory, ['add', file]);
    await git(directory, ['commit', '--quiet', '-m', file]);
    return (await git(directory, ['rev-parse', 'HEAD'])).trim();
  }

  async function head(directory: string): Promise<string> {
    return (await git(directory, ['rev-parse', 'HEAD'])).trim();
  }

  async function child(): Promise<ChatSessionSummary | undefined> {
    return (await store.list()).find(session => session.origin);
  }

  /** The child's worktree, once the background half of the start has cut it. */
  async function worktreeOf(branch: string): Promise<string> {
    const path = join(appWorktreeRoot(container), branch.replace('/', '+'));
    await vi.waitUntil(async () => (await child())?.project?.workingDirectory === path, {
      timeout: 10000,
      interval: 10,
    });
    return path;
  }

  function holdWorktrees(): () => void {
    let release = () => {};
    gate.hold = new Promise<void>(resolve => {
      release = resolve;
    });
    return release;
  }

  function seedPosted(text: string): boolean {
    return post.mock.calls.some(call => String(call[1]?.messages?.[1]?.content ?? '').includes(text));
  }

  it('gives the child a worktree of its own when the user starts it in one', async () => {
    const { parent, result } = await spawnWith({ placement: 'worktree', branch: 'agent/the-thing' });

    expect(result.ok).toBe(true);
    await worktreeOf('agent/the-thing');
    expect((await child())?.project).toMatchObject({
      branch: 'main',
      workspaceBranch: 'agent/the-thing',
      workspace: true,
      workingDirectory: join(appWorktreeRoot(container), 'agent+the-thing'),
    });

    // A real checkout, not just a field: the point of the option is that the child has files of
    // its own, and the parent's are still where they were.
    expect((await stat(join(appWorktreeRoot(container), 'agent+the-thing', 'README.md'))).isFile()).toBe(true);
    expect((await store.get(parent.id))?.project?.workingDirectory).toBe(main);
  });

  /** An orchestrating parent asks for one spawn, which starts without a card. */
  async function delegate(task: { prompt: string; title: string } = { prompt: 'do the thing', title: 'The thing' }) {
    const parent = await parentSession();
    await service.setSessionOrchestrate(parent.id, true);
    await service.send(parent.id, 'go');
    await vi.waitUntil(() => streams.length > 0, { timeout: 5000, interval: 5 });
    requestSpawn(streams[0], 'call-1', task.prompt, task.title);
    await awaitSettled(1);
    return { parent, call: settled()[0] };
  }

  it('gives a delegated agent a worktree of its own in a repository, as the card does by default', async () => {
    const { parent, call } = await delegate();

    expect(call?.status).toBe('done');
    expect(call?.preview).toContain('It has its own worktree on agent/the-thing, cut from main');
    await worktreeOf('agent/the-thing');
    expect((await stat(join(appWorktreeRoot(container), 'agent+the-thing', 'README.md'))).isFile()).toBe(true);
    expect((await store.get(parent.id))?.project?.workingDirectory).toBe(main);
  });

  it('gives a delegated agent a fresh branch when an earlier attempt left its branch behind', async () => {
    await git(main, ['branch', 'agent/the-thing']);

    const { parent, call } = await delegate();

    expect(call?.status).toBe('done');
    expect(call?.preview).toContain('It has its own worktree on agent/the-thing-2, cut from main');
    await worktreeOf('agent/the-thing-2');
    expect((await store.get(parent.id))?.project?.workingDirectory).toBe(main);
  });

  it('never runs a delegated agent in the parent directory when its worktree cannot be made', async () => {
    gate.fail = new Error('git worktree add timed out after 5 min.');

    const { parent } = await delegate();

    const failed = await vi.waitUntil(() => events.find(event => event.type === 'spawn-failed'), {
      timeout: 5000,
      interval: 10,
    });
    expect(failed).toMatchObject({ sessionId: parent.id });
    expect(failed.type === 'spawn-failed' ? failed.message : '').toContain(
      'The worktree could not be created: git worktree add timed out after 5 min.'
    );
    await vi.waitUntil(async () => (await child()) === undefined, { timeout: 5000, interval: 10 });
    expect(seedPosted('do the thing')).toBe(false);
  });

  /** The parent ends its turn after starting its agent, so only the agent's end is left to wake it. */
  async function endParentTurn(): Promise<void> {
    const stream = await vi.waitUntil(() => streams[1], { timeout: 5000, interval: 5 });
    stream.write(frame({ type: 'content', text: 'Started it.' }));
    stream.write(frame('[DONE]'));
  }

  async function agentsSettledWake(parentId: string): Promise<string> {
    const wake = await vi.waitUntil(
      async () => (await store.get(parentId))?.messages.find(message => message.automatic?.kind === 'agents-settled'),
      { timeout: 5000, interval: 10 }
    );
    return wake.content;
  }

  it('wakes an Orchestrate parent when a delegated agent fails to get its worktree', async () => {
    gate.fail = new Error('git worktree add timed out after 5 min.');
    const { parent } = await delegate();
    await endParentTurn();

    const wake = await agentsSettledWake(parent.id);
    expect(wake).toContain('"The thing"');
    expect(wake).toContain(': failed.');
  });

  it('wakes an Orchestrate parent when a delegated agent is stopped while it is preparing', async () => {
    const release = holdWorktrees();
    const { parent } = await delegate();
    const spawned = await vi.waitUntil(child, { timeout: 5000, interval: 10 });
    await endParentTurn();
    await vi.waitUntil(() => !service.isSessionBusy(parent.id), { timeout: 5000, interval: 5 });

    service.stop(spawned.id);
    release();

    const wake = await agentsSettledWake(parent.id);
    expect(wake).toContain(': stopped');
  });

  it('gives back the branch name a delegated spawn reserved when creating its session throws', async () => {
    const create = store.create.bind(store);
    vi.spyOn(store, 'create').mockImplementation((...args: Parameters<SessionStore['create']>) =>
      args[1]?.origin ? Promise.reject(new Error('disk full')) : create(...args)
    );

    const { call } = await delegate();

    expect(call?.status).toBe('error');
    expect(await child()).toBeUndefined();
    const again = reserveBranchName(main, 'agent/the-thing');
    expect(again).not.toBeNull();
    releaseBranchName(again!);
  });

  it('refuses a card branch another spawn is setting up, and its refusal frees nothing', async () => {
    const delegated = reserveBranchName(main, 'agent/in-flight');

    const { result } = await spawnWith({ placement: 'worktree', branch: 'agent/in-flight' });

    expect(await child()).toBeUndefined();
    expect(!result.ok && result.error).toMatch(/already setting up the branch agent\/in-flight/);
    expect(reserveBranchName(main, 'agent/in-flight')).toBeNull();
    releaseBranchName(delegated!);
  });

  it('starts nothing when the model only suggests, and leaves the tool call done', async () => {
    const parent = await parentSession();
    await service.send(parent.id, 'go');
    await vi.waitUntil(() => streams.length > 0, { timeout: 5000, interval: 5 });

    await suggest();

    expect(await child()).toBeUndefined();
    expect(prefetchBase).toHaveBeenCalledWith(main, 'main');
    expect(await listWorktrees(main)).toHaveLength(1);
    expect(settled()[0]?.status).toBe('done');
    expect(settled()[0]?.preview).toMatch(/Nothing has started/);
  });

  it('starts while the parent is still mid-reply, and the child gets its worktree', async () => {
    const parent = await parentSession();
    await service.send(parent.id, 'go');
    await vi.waitUntil(() => streams.length > 0, { timeout: 5000, interval: 5 });
    const suggestion = await suggest();
    // The tool result goes back to the model, whose next round is a second open stream: the
    // parent's turn has not ended.
    await vi.waitUntil(() => streams.length > 1, { timeout: 5000, interval: 5 });
    expect(events.some(event => event.type === 'done')).toBe(false);

    const result = await start(parent, suggestion, { placement: 'worktree', branch: 'agent/while-busy' });

    expect(result.ok).toBe(true);
    expect(events.some(event => event.type === 'done')).toBe(false);
    await worktreeOf('agent/while-busy');
    expect((await child())?.project).toMatchObject({
      workspaceBranch: 'agent/while-busy',
      workingDirectory: join(appWorktreeRoot(container), 'agent+while-busy'),
    });
    expect((await stat(join(appWorktreeRoot(container), 'agent+while-busy', 'README.md'))).isFile()).toBe(true);
  });

  it('tells a child in a worktree where it is, since its task was written before anyone knew', async () => {
    // The live failure this exists for: the parent names files by ITS absolute path - the user
    // picks the placement only afterwards - so the child's file tools refuse those paths and its
    // shell works in the wrong checkout. Observed, not hypothetical.
    await spawnWith({ placement: 'worktree', branch: 'agent/told-where' });

    const worktree = join(appWorktreeRoot(container), 'agent+told-where');
    const body = await vi.waitUntil(
      () => post.mock.calls.map(call => call[1]?.messages?.[1]?.content).find(text => /told-where/.test(String(text))),
      { timeout: 5000, interval: 5 }
    );
    expect(body).toContain(worktree);
    expect(body).toContain('agent/told-where cut from main');
    expect(body).toContain(main);
    expect(body).toMatch(/Do not read or\nwrite under it/);
    // The task itself is passed through untouched: rewriting it would be guessing which mentions
    // of a path meant "this repository" and which meant that exact directory.
    expect(body).toContain('do the thing');
  });

  it("leaves a local child's seed exactly as the parent wrote it", async () => {
    await spawnWith({ placement: 'local' });

    const body = await vi.waitUntil(
      () => post.mock.calls.map(call => call[1]?.messages?.[1]?.content).find(text => text === 'do the thing'),
      { timeout: 5000, interval: 5 }
    );
    expect(body).toBe('do the thing');
  });

  it('puts the child in the parent working directory on "Start locally", exactly as before', async () => {
    const before = (await listWorktrees(main)).length;

    const { parent } = await spawnWith({ placement: 'local' });

    expect((await child())?.project).toEqual((await store.get(parent.id))?.project);
    // Nothing was checked out, which is the other half of "exactly as before".
    expect(await listWorktrees(main)).toHaveLength(before);
  });

  it('refuses the parent own branch rather than handing back the parent worktree', async () => {
    // The trap this exists for: resolveWorkspace is keyed on branch, so 'main' would resolve to
    // the checkout the parent is already in, while the row and the chip claimed isolation.
    const { parent, suggestion, result } = await spawnWith({ placement: 'worktree', branch: 'main' });

    expect(await child()).toBeUndefined();
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toMatch(/this conversation's own branch/);
    expect((await store.get(parent.id))?.spawnSuggestions?.find(entry => entry.id === suggestion.id)?.status).toBe(
      'pending'
    );
  });

  it('refuses a branch that already exists rather than adopting its worktree', async () => {
    await git(main, ['branch', 'agent/taken']);

    const { result } = await spawnWith({ placement: 'worktree', branch: 'agent/taken' });

    expect(await child()).toBeUndefined();
    expect(!result.ok && result.error).toMatch(/already exists/);
  });

  it('refuses a branch name git would not take', async () => {
    const { result } = await spawnWith({ placement: 'worktree', branch: 'not a branch' });

    expect(await child()).toBeUndefined();
    expect(!result.ok && result.error).toMatch(/not a usable branch name/);
  });

  it('shows the child before its worktree exists, and runs nothing until it does', async () => {
    const release = holdWorktrees();
    const { parent, result } = await spawnWith({ placement: 'worktree', branch: 'agent/early' });

    expect(result.ok).toBe(true);
    const early = await child();
    expect(early?.project).toMatchObject({ workspace: true, workspaceBranch: 'agent/early', workingDirectory: main });
    expect(early?.project && awaitsWorktree(early.project)).toBe(true);
    expect((await service.getSession(early!.id))?.preparingWorkspace).toMatchObject({ base: 'main' });

    // Busy while preparing, so neither the seed nor anything the user types can run in the
    // repository folder the session is parked on.
    expect(await service.send(early!.id, 'run ls')).toMatchObject({ ok: true, queued: true });
    expect(seedPosted('do the thing')).toBe(false);

    release();
    const worktree = await worktreeOf('agent/early');
    await vi.waitUntil(() => seedPosted(worktree), { timeout: 5000, interval: 5 });
    expect((await service.getSession(early!.id))?.preparingWorkspace).toBeUndefined();
    expect((await store.get(parent.id))?.project?.workingDirectory).toBe(main);
  });

  it('does not launch or install after a preparing child is deleted', async () => {
    const release = holdWorktrees();
    await spawnWith({ placement: 'worktree', branch: 'agent/deleted' });
    const spawned = await child();
    if (!spawned) throw new Error('Child missing');
    await service.deleteSession(spawned.id);

    release();
    await vi.waitUntil(
      () => events.some(event => event.type === 'workspace' && event.sessionId === spawned.id && !event.running),
      { timeout: 10000, interval: 5 }
    );
    await vi.waitUntil(() => !service.isSessionBusy(spawned.id), { timeout: 5000, interval: 5 });

    expect(await store.get(spawned.id)).toBeNull();
    expect(dependencies.maybeStart).not.toHaveBeenCalled();
    expect(seedPosted('do the thing')).toBe(false);
    expect(events.some(event => event.type === 'spawn-failed')).toBe(false);
  });

  /** Internal bookkeeping a spawn must give back however it ends. */
  function spawnBookkeeping(sessionId: string) {
    const internals = service as unknown as {
      spawnWatch: Map<string, unknown>;
      launching: Set<string>;
      launchInterrupts: Map<string, unknown>;
    };
    return {
      watched: internals.spawnWatch.has(sessionId),
      launching: internals.launching.has(sessionId),
      interrupted: internals.launchInterrupts.has(sessionId),
    };
  }

  /** A spawn held mid-cut, so the test can stop or delete it while it is still preparing. */
  async function spawnHeldInWorktree(branch: string) {
    const release = holdWorktrees();
    const { parent } = await spawnWith({ placement: 'worktree', branch });
    const spawned = await child();
    if (!spawned) throw new Error('Child missing');
    return { release, parent, spawned };
  }

  it("tells a spawned agent's first turn that its install is running, even when the install is slow to start", async () => {
    // Upstream, since a worktree is cut from the freshly fetched base rather than local main.
    const source = join(container, '..', 'source');
    await writeFile(join(source, 'package.json'), '{"name":"demo"}\n', 'utf8');
    await writeFile(join(source, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n", 'utf8');
    await git(source, ['add', 'package.json', 'pnpm-lock.yaml']);
    await git(source, ['commit', '--quiet', '-m', 'lockfile']);
    vi.mocked(dependencies.maybeStart).mockRestore();
    const registry = (dependencies as unknown as { registry: BackgroundProcessRegistry }).registry;
    let install: BackgroundProcessInfo | null = null;
    vi.spyOn(registry, 'start').mockImplementation(async request => {
      // Slower than the rest of the launch, so a launch that does not wait for the plan races past it.
      await new Promise(resolve => setTimeout(resolve, 200));
      install = {
        id: 'inst0001',
        sessionId: request.sessionId,
        command: request.command,
        cwd: request.cwd,
        status: 'running',
        startedAt: new Date().toISOString(),
        bufferedChars: 0,
        droppedChars: 0,
      };
      return install;
    });
    vi.spyOn(registry, 'get').mockImplementation(() => install);

    await spawnWith({ placement: 'worktree', branch: 'agent/install-announced' });
    const worktree = await worktreeOf('agent/install-announced');
    await vi.waitUntil(() => seedPosted(worktree), { timeout: 5000, interval: 5 });

    const first = post.mock.calls.find(call => String(call[1]?.messages?.[1]?.content ?? '').includes(worktree));
    const prompt = JSON.stringify(first?.[1]?.messages ?? []);
    expect(prompt).toContain('Dependencies are installing in the background (handle inst0001');
    expect(prompt).toContain('wait_seconds=');
  });

  it('starts no turn and leaks nothing when the agent is deleted while preparing', async () => {
    const { release, spawned } = await spawnHeldInWorktree('agent/prep-deleted');

    await service.deleteSession(spawned.id);
    release();
    await vi.waitUntil(() => !service.isSessionBusy(spawned.id), { timeout: 5000, interval: 5 });
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(await store.get(spawned.id)).toBeNull();
    expect(seedPosted('do the thing')).toBe(false);
    expect(events.some(event => event.type === 'spawn-failed')).toBe(false);
    expect(spawnBookkeeping(spawned.id)).toEqual({ watched: false, launching: false, interrupted: false });
  });

  it('keeps an agent stopped while preparing, with its task handed back unsent', async () => {
    const { release, parent, spawned } = await spawnHeldInWorktree('agent/prep-stopped');

    service.stop(spawned.id);
    release();
    const worktree = await worktreeOf('agent/prep-stopped');
    await vi.waitUntil(() => !service.isSessionBusy(spawned.id), { timeout: 5000, interval: 5 });
    await vi.waitUntil(() => queueEvents.some(event => event.sessionId === spawned.id && event.returned), {
      timeout: 5000,
      interval: 5,
    });

    expect(seedPosted(worktree)).toBe(false);
    expect(queueEvents.find(event => event.sessionId === spawned.id && event.returned)?.returned).toMatchObject({
      reason: 'stopped',
      messages: [{ text: 'do the thing' }],
    });
    const kept = await store.get(spawned.id);
    expect(kept?.messages.some(message => message.system && message.content.includes('do the thing'))).toBe(true);
    expect((await listWorktrees(main)).some(entry => entry.path === worktree)).toBe(true);
    expect(events.some(event => event.type === 'spawn-failed')).toBe(false);
    expect(spawnBookkeeping(spawned.id)).toEqual({ watched: false, launching: false, interrupted: false });

    const round = await vi.waitUntil(() => streams[1], { timeout: 5000, interval: 5 });
    round.write(frame({ type: 'content', text: 'ok' }));
    round.write(frame('[DONE]'));
    await vi.waitUntil(
      () =>
        events.some(
          event =>
            event.type === 'message' &&
            event.sessionId === parent.id &&
            /was stopped by the user before it began/.test(event.message.content)
        ),
      { timeout: 5000, interval: 10 }
    );
  });

  it('keeps other turns blocked until a failed spawn has been removed', async () => {
    await mkdir(join(appWorktreeRoot(container), 'agent+cleanup'), { recursive: true });
    await writeFile(join(appWorktreeRoot(container), 'agent+cleanup', 'stray.txt'), 'not mine\n', 'utf8');
    let releaseDelete = () => {};
    const deletion = new Promise<void>(resolve => {
      releaseDelete = resolve;
    });
    let deletingId: string | undefined;
    const originalDelete = store.delete.bind(store);
    vi.spyOn(store, 'delete').mockImplementation(async sessionId => {
      deletingId = sessionId;
      await deletion;
      return originalDelete(sessionId);
    });

    const { parent } = await spawnWith({ placement: 'worktree', branch: 'agent/cleanup' });
    await vi.waitUntil(() => deletingId, { timeout: 10000, interval: 5 });
    if (!deletingId) throw new Error('Deletion did not start');

    expect(service.isSessionBusy(deletingId)).toBe(true);
    expect(await service.send(deletingId, 'must not run')).toMatchObject({ ok: false });
    expect(seedPosted('must not run')).toBe(false);
    const relay = await relayFromParent(parent.id, deletingId, 'must not relay');
    expect(relay.status).toBe('error');
    expect(queue.list(deletingId)).toEqual([]);
    releaseDelete();
    await vi.waitUntil(() => events.some(event => event.type === 'spawn-failed'), { timeout: 5000, interval: 5 });
    expect(await store.get(deletingId)).toBeNull();
    expect(queue.list(deletingId)).toEqual([]);
  });

  it('preserves queued input and attachment bytes when background startup fails', async () => {
    const release = holdWorktrees();
    const { parent, suggestion } = await spawnWith({ placement: 'worktree', branch: 'agent/preserve-input' });
    const spawned = await child();
    if (!spawned) throw new Error('Child missing');
    const added = await attachments.add(spawned.id, [
      { source: 'bytes', name: 'notes.txt', data: new Uint8Array(Buffer.from('keep these notes')) },
    ]);
    expect(added.attachments).toHaveLength(1);
    expect(await service.send(spawned.id, 'also check these notes', added.attachments)).toMatchObject({
      ok: true,
      queued: true,
    });
    expect((await relayFromParent(parent.id, spawned.id, 'keep this relay')).status).toBe('done');
    await mkdir(join(appWorktreeRoot(container), 'agent+preserve-input'), { recursive: true });
    await writeFile(join(appWorktreeRoot(container), 'agent+preserve-input', 'stray.txt'), 'not mine\n', 'utf8');
    release();
    await vi.waitUntil(() => events.some(event => event.type === 'spawn-failed'), { timeout: 10000, interval: 5 });
    await vi.waitUntil(() => !service.isSessionBusy(spawned.id), { timeout: 5000, interval: 5 });

    const retained = await store.get(spawned.id);
    expect(retained).not.toBeNull();
    expect(retained?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining('also check these notes'),
          attachments: added.attachments,
        }),
        expect.objectContaining({ content: expect.stringContaining('do the thing') }),
      ])
    );
    expect(retained?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: 'keep this relay',
          relay: expect.objectContaining({ fromSessionId: parent.id }),
        }),
      ])
    );
    const returned = queueEvents.findLast(event => event.sessionId === spawned.id && event.returned)?.returned;
    expect(returned?.messages.map(message => message.text)).toEqual(['do the thing', 'also check these notes']);
    expect(returned?.messages[1].attachments).toEqual(added.attachments);
    expect(await attachments.read(spawned.id, added.attachments[0].id)).toEqual(Buffer.from('keep these notes'));
    expect(queue.list(spawned.id)).toEqual([]);
    expect(seedPosted('do the thing')).toBe(false);
    expect(events.findLast(event => event.type === 'spawn-failed')).toMatchObject({
      message: expect.stringMatching(/kept|retained/i),
    });
    expect((await store.get(parent.id))?.spawnSuggestions?.find(entry => entry.id === suggestion.id)?.status).toBe(
      'started'
    );
  });

  it('keeps accepted input queued if saving startup recovery fails', async () => {
    const release = holdWorktrees();
    await spawnWith({ placement: 'worktree', branch: 'agent/recovery-error' });
    const spawned = await child();
    if (!spawned) throw new Error('Child missing');
    expect(await service.send(spawned.id, 'do not lose this')).toMatchObject({ ok: true, queued: true });
    await mkdir(join(appWorktreeRoot(container), 'agent+recovery-error'), { recursive: true });
    await writeFile(join(appWorktreeRoot(container), 'agent+recovery-error', 'stray.txt'), 'not mine\n', 'utf8');
    const appendMessage = store.appendMessage.bind(store);
    vi.spyOn(store, 'appendMessage').mockImplementation(async (sessionId, message) => {
      if (sessionId === spawned.id) throw new Error('disk full');
      return appendMessage(sessionId, message);
    });
    release();
    await vi.waitUntil(() => !service.isSessionBusy(spawned.id), { timeout: 10000, interval: 5 });
    expect(await store.get(spawned.id)).not.toBeNull();
    expect(queue.list(spawned.id).map(message => message.text)).toEqual(['do not lose this']);
    expect(queueEvents.some(event => event.sessionId === spawned.id && event.returned)).toBe(false);
    expect(seedPosted('do the thing')).toBe(false);
  });

  it.each(['local', 'worktree'] as const)('reserves the seed ahead of other turns for a %s spawn', async placement => {
    const parent = await parentSession();
    await service.send(parent.id, 'go');
    await vi.waitUntil(() => streams.length > 0, { timeout: 5000, interval: 5 });
    const suggestion = await suggest();
    const originalGet = store.get.bind(store);
    let releaseSeed = () => {};
    const seedGate = new Promise<void>(resolve => {
      releaseSeed = resolve;
    });
    let seedReading = false;
    vi.spyOn(store, 'get').mockImplementation(async sessionId => {
      const session = await originalGet(sessionId);
      const workspaceReady =
        placement === 'local' ||
        events.some(event => event.type === 'workspace' && event.sessionId === sessionId && !event.running);
      if (session?.origin && workspaceReady && !seedReading) {
        seedReading = true;
        await seedGate;
      }
      return session;
    });

    const result = await start(
      parent,
      suggestion,
      placement === 'worktree' ? { placement, branch: 'agent/seed-first' } : { placement }
    );
    expect(result.ok).toBe(true);
    await vi.waitUntil(() => seedReading, { timeout: 10000, interval: 5 });
    const spawned = (await store.list()).find(session => session.origin);
    if (!spawned) throw new Error('Child missing');

    expect(service.isSessionBusy(spawned.id)).toBe(true);
    expect(await service.send(spawned.id, 'user follow-up')).toMatchObject({ ok: true, queued: true });
    expect(
      await service.startAutomaticTurn(spawned.id, 'automatic follow-up', {
        kind: 'auto-fix',
        prUrl: 'https://github.com/example/project/pull/1',
        prNumber: 1,
        summary: 'check failed',
      })
    ).toMatchObject({ ok: false, busy: true });
    expect(seedPosted('user follow-up')).toBe(false);

    releaseSeed();
    await vi.waitUntil(() => seedPosted('do the thing'), { timeout: 10000, interval: 5 });
    expect((await store.get(spawned.id))?.messages[0]?.content).toContain('do the thing');
    expect(queue.list(spawned.id)[0]?.text).toBe('user follow-up');
  });

  it('holds the concurrency cap while its sessions are still preparing', async () => {
    const release = holdWorktrees();
    const parent = await parentSession();
    await service.send(parent.id, 'go');
    await vi.waitUntil(() => streams.length > 0, { timeout: 5000, interval: 5 });
    streams[0].write(
      frame({
        type: 'tool_use',
        tools: Array.from({ length: MAX_CONCURRENT_SPAWNED + 1 }, (_unused, index) => ({
          id: `call-${index}`,
          name: 'session_spawn',
          arguments: JSON.stringify({ prompt: `task ${index}`, title: `Cap ${index}` }),
        })),
      })
    );
    streams[0].write(frame('[DONE]'));
    const suggestions = await vi.waitUntil(
      () => {
        const latest = events.findLast(event => event.type === 'spawn-suggestions');
        const pending = latest?.type === 'spawn-suggestions' ? latest.suggestions : [];
        return pending.length === MAX_CONCURRENT_SPAWNED + 1 ? pending : undefined;
      },
      { timeout: 5000, interval: 5 }
    );

    const results = await Promise.all(
      suggestions.map((suggestion, index) =>
        start(parent, suggestion, { placement: 'worktree', branch: `agent/cap-${index}` })
      )
    );

    expect(results.filter(result => result.ok)).toHaveLength(MAX_CONCURRENT_SPAWNED);
    expect(results.find(result => !result.ok)).toMatchObject({
      error: expect.stringMatching(/already running, which is the limit/),
    });
    expect((await store.list()).filter(session => session.origin)).toHaveLength(MAX_CONCURRENT_SPAWNED);
    release();
  });

  it('removes a session whose worktree cannot be created, and says so to the user and the parent', async () => {
    // Something already at the path that git does not know as a worktree: resolveWorkspace refuses
    // it rather than clobbering it, and the session that was shown for it has to go again.
    await mkdir(join(appWorktreeRoot(container), 'agent+blocked'), { recursive: true });
    await writeFile(join(appWorktreeRoot(container), 'agent+blocked', 'stray.txt'), 'not mine\n', 'utf8');

    const { parent, suggestion, result } = await spawnWith({ placement: 'worktree', branch: 'agent/blocked' });

    expect(result.ok).toBe(true);
    const failed = await vi.waitUntil(() => events.find(event => event.type === 'spawn-failed'), {
      timeout: 10000,
      interval: 10,
    });
    expect(failed).toMatchObject({
      sessionId: parent.id,
      title: 'The thing',
      message: expect.stringMatching(/could not be created/),
    });
    expect(await child()).toBeUndefined();
    await vi.waitUntil(
      async () =>
        (await store.get(parent.id))?.spawnSuggestions?.find(entry => entry.id === suggestion.id)?.status === 'pending',
      { timeout: 5000, interval: 10 }
    );
    // Untouched, which is the other half of refusing rather than adopting.
    expect(await readFile(join(appWorktreeRoot(container), 'agent+blocked', 'stray.txt'), 'utf8')).toBe('not mine\n');

    // The parent hears it once its own turn is over, as it hears every child.
    const round = await vi.waitUntil(() => streams[1], { timeout: 5000, interval: 5 });
    round.write(frame({ type: 'content', text: 'ok' }));
    round.write(frame('[DONE]'));
    await vi.waitUntil(
      () =>
        events.some(
          event =>
            event.type === 'message' &&
            event.sessionId === parent.id &&
            /could not start and was removed/.test(event.message.content)
        ),
      { timeout: 5000, interval: 10 }
    );
  });

  it('keeps the approval-mode ceiling and the depth count on a child in its own worktree', async () => {
    const parent = await parentSession();
    await store.setApprovalMode(parent.id, 'full');
    await service.send(parent.id, 'go');
    await vi.waitUntil(() => streams.length > 0, { timeout: 5000, interval: 5 });

    const { result } = await startOn(parent, { placement: 'worktree', branch: 'agent/isolated' });

    expect(result.ok).toBe(true);
    const spawned = await child();
    expect(spawned?.approvalMode).toBe('auto');
    expect(spawned?.origin).toMatchObject({ parentSessionId: parent.id, depth: 1 });
  });

  it('cuts the child from the branch a plain-checkout parent has checked out, and says so', async () => {
    const parent = await parentSession();
    // Switched after the session recorded 'main', so the base can only have come from git.
    await git(main, ['switch', '--quiet', '-c', 'feat/parent']);
    const tip = await commit(main, 'parent.txt');
    await service.send(parent.id, 'go');
    await vi.waitUntil(() => streams.length > 0, { timeout: 5000, interval: 5 });

    const { suggestion } = await startOn(parent, { placement: 'worktree', branch: 'agent/from-parent' });

    expect(suggestion.base).toBe('feat/parent');
    const worktree = await worktreeOf('agent/from-parent');
    expect(await head(worktree)).toBe(tip);
  });

  it("cuts the child from a worktree parent's own branch, with the commits it has not pushed", async () => {
    const created = await service.createCodeSession({ directory: main, branch: 'main', workspace: true });
    if (!created.ok) throw new Error(created.error);
    await service.send(created.session.id, 'go');
    await vi.waitUntil(() => streams.length > 0, { timeout: 5000, interval: 5 });
    const project = (await store.get(created.session.id))?.project;
    const parentBranch = project?.workspaceBranch as string;
    expect(parentBranch).toMatch(/^b4m\//);
    const tip = await commit(project?.workingDirectory as string, 'unpushed.txt');

    const { suggestion } = await startOn(created.session, { placement: 'worktree', branch: 'agent/from-worktree' });

    expect(suggestion.base).toBe(parentBranch);
    expect(await head(await worktreeOf('agent/from-worktree'))).toBe(tip);
    expect(await head(main)).not.toBe(tip);
  });

  it('falls back to origin/main for a parent on a detached HEAD, and the suggestion names it', async () => {
    const bare = join(container, '.bare');
    // A real remote-tracking ref, which `clone --bare` does not write, ahead of the checkout.
    await git(bare, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    const source = join(container, '..', 'source');
    const remoteTip = await commit(source, 'remote.txt');
    await git(bare, ['fetch', '--quiet', 'origin']);
    await git(main, ['checkout', '--quiet', '--detach', 'HEAD']);

    const created = await service.createCodeSession({ directory: main, workspace: false });
    if (!created.ok) throw new Error(created.error);
    await service.send(created.session.id, 'go');
    await vi.waitUntil(() => streams.length > 0, { timeout: 5000, interval: 5 });

    const { suggestion } = await startOn(created.session, { placement: 'worktree', branch: 'agent/detached' });

    expect(suggestion.base).toBe('origin/main');
    expect(await head(await worktreeOf('agent/detached'))).toBe(remoteTip);
  });

  it('records the prefilled branch and the base, and a dismissal starts nothing', async () => {
    const parent = await parentSession();
    await service.send(parent.id, 'go');
    await vi.waitUntil(() => streams.length > 0, { timeout: 5000, interval: 5 });
    requestSpawn(streams[0], 'call-1', 'tidy the imports', 'Tidy imports');

    const suggestion = await awaitSuggestion();
    expect(suggestion).toMatchObject({ branch: 'agent/tidy-imports', base: 'main', status: 'pending' });

    const dismissed = await service.dismissSpawnSuggestion(parent.id, suggestion.id);

    expect(dismissed).toMatchObject({ ok: true, suggestion: { status: 'dismissed' } });
    expect((await store.get(parent.id))?.spawnSuggestions?.[0]?.status).toBe('dismissed');
    expect(await child()).toBeUndefined();
    expect(await listWorktrees(main)).toHaveLength(1);
  });
});
