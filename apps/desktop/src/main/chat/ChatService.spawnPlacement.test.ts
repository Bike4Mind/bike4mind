import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatSessionSummary, ChatSpawnSuggestion, ChatStreamEvent } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import { git, listWorktrees } from './project/git';
import { appWorktreeRoot } from './project/workspace';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';

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
    await repository();
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-place-sessions-')), 'test-model');
    events = [];
    streams = [];
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });

    service = new ChatService({
      store,
      approvals: new ApprovalGate(),
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => events.push(event),
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

  it('gives the child a worktree of its own when the user starts it in one', async () => {
    const { parent, result } = await spawnWith({ placement: 'worktree', branch: 'agent/the-thing' });

    expect(result.ok).toBe(true);
    expect((await child())?.project).toMatchObject({
      branch: 'agent/the-thing',
      workspace: true,
      workingDirectory: join(appWorktreeRoot(container), 'agent+the-thing'),
    });

    // A real checkout, not just a field: the point of the option is that the child has files of
    // its own, and the parent's are still where they were.
    expect((await stat(join(appWorktreeRoot(container), 'agent+the-thing', 'README.md'))).isFile()).toBe(true);
    expect((await store.get(parent.id))?.project?.workingDirectory).toBe(main);
  });

  it('starts nothing when the model only suggests, and leaves the tool call done', async () => {
    const parent = await parentSession();
    await service.send(parent.id, 'go');
    await vi.waitUntil(() => streams.length > 0, { timeout: 5000, interval: 5 });

    await suggest();

    expect(await child()).toBeUndefined();
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
    expect((await child())?.project).toMatchObject({
      branch: 'agent/while-busy',
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

  it('leaves no half-made session when the worktree cannot be created', async () => {
    // Something already at the path that git does not know as a worktree: resolveWorkspace refuses
    // it rather than clobbering it, and that refusal has to land BEFORE a session exists.
    await mkdir(join(appWorktreeRoot(container), 'agent+blocked'), { recursive: true });
    await writeFile(join(appWorktreeRoot(container), 'agent+blocked', 'stray.txt'), 'not mine\n', 'utf8');

    const { result } = await spawnWith({ placement: 'worktree', branch: 'agent/blocked' });

    expect(await child()).toBeUndefined();
    expect(!result.ok && result.error).toMatch(/could not be created/);
    // Untouched, which is the other half of refusing rather than adopting.
    expect(await readFile(join(appWorktreeRoot(container), 'agent+blocked', 'stray.txt'), 'utf8')).toBe('not mine\n');
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
    const worktree = join(appWorktreeRoot(container), 'agent+from-parent');
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
    expect(await head(join(appWorktreeRoot(container), 'agent+from-worktree'))).toBe(tip);
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
    expect(await head(join(appWorktreeRoot(container), 'agent+detached'))).toBe(remoteTip);
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
