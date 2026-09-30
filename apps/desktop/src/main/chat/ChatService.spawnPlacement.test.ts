import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatApprovalAnswer, ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import { git, listWorktrees } from './project/git';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

/**
 * Where a spawned session's tools run, which the USER picks on the approval card.
 *
 * A real repository in the user's container layout underneath, because what is being tested is
 * whether a checkout is actually made and where - stubbing resolveWorkspace would assert only
 * that this code calls the code it calls.
 *
 * Its own file rather than ChatService.spawn.test.ts because that one states, and depends on,
 * having no approval gate: its subject is the caps holding against a model that ignores them, and
 * a gate would stop the loop before the caps did. The choice only exists AT the gate, so there is
 * nothing here to test without one.
 */
describe('ChatService spawn placement', () => {
  let store: SessionStore;
  let service: ChatService;
  let approvals: ApprovalGate;
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
    approvals = new ApprovalGate();
    events = [];
    streams = [];
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });

    service = new ChatService({
      store,
      approvals,
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

  /** The call now parked at the gate, once its card has been announced. */
  function awaitCard() {
    return vi.waitUntil(
      () =>
        events
          .filter(event => event.type === 'tool-start')
          .map(event => (event.type === 'tool-start' ? event.call : null))
          .find(call => call?.status === 'awaiting-approval' && call.name === 'session_spawn'),
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

  /** The newest open stream whose first user message is `prompt`; index 0 is the access preamble. */
  function awaitStreamOfPrompt(prompt: string): Promise<PassThrough> {
    return vi.waitUntil(
      () => {
        for (let index = streams.length - 1; index >= 0; index--) {
          const messages = post.mock.calls[index]?.[1]?.messages as { role: string; content: unknown }[] | undefined;
          if (messages?.[1]?.content === prompt) return streams[index];
        }
        return undefined;
      },
      { timeout: 5000, interval: 5 }
    );
  }

  /** Drive one spawn from the model's request through to the user's answer on the card. */
  async function spawnWith(
    answer: ChatApprovalAnswer,
    task: { prompt: string; title: string } = { prompt: 'do the thing', title: 'The thing' }
  ): Promise<ChatSessionSummary> {
    const parent = await parentSession();
    await service.send(parent.id, 'go');
    await vi.waitUntil(() => streams.length > 0, { timeout: 5000, interval: 5 });
    requestSpawn(streams[0], 'call-1', task.prompt, task.title);

    const card = await awaitCard();
    approvals.resolve(card.approvalId as string, answer);
    await awaitSettled(1);
    return parent;
  }

  async function child(): Promise<ChatSessionSummary | undefined> {
    return (await store.list()).find(session => session.origin);
  }

  it('gives the child a worktree of its own on the default choice', async () => {
    const parent = await spawnWith({ decision: 'once', optionId: 'worktree', value: 'agent/the-thing' });

    expect((await child())?.project).toMatchObject({
      branch: 'agent/the-thing',
      workspace: true,
      workingDirectory: join(container, 'agent+the-thing'),
    });

    // A real checkout, not just a field: the point of the option is that the child has files of
    // its own, and the parent's are still where they were.
    expect((await stat(join(container, 'agent+the-thing', 'README.md'))).isFile()).toBe(true);
    expect((await store.get(parent.id))?.project?.workingDirectory).toBe(main);
    expect(settled()[0]?.status).toBe('done');
  });

  it('tells a child in a worktree where it is, since its task was written before anyone knew', async () => {
    // The live failure this exists for: the parent names files by ITS absolute path - the user
    // picks the placement only afterwards - so the child's file tools refuse those paths and its
    // shell works in the wrong checkout. Observed, not hypothetical.
    await spawnWith({ decision: 'once', optionId: 'worktree', value: 'agent/told-where' });

    const worktree = join(container, 'agent+told-where');
    const body = await vi.waitUntil(
      () => post.mock.calls.map(call => call[1]?.messages?.[1]?.content).find(text => /told-where/.test(String(text))),
      { timeout: 5000, interval: 5 }
    );
    expect(body).toContain(worktree);
    expect(body).toContain('agent/told-where');
    expect(body).toContain(main);
    expect(body).toMatch(/Do not read or\nwrite under it/);
    // The task itself is passed through untouched: rewriting it would be guessing which mentions
    // of a path meant "this repository" and which meant that exact directory.
    expect(body).toContain('do the thing');
  });

  it("leaves a local child's seed exactly as the parent wrote it", async () => {
    await spawnWith({ decision: 'once', optionId: 'local' });

    const body = await vi.waitUntil(
      () => post.mock.calls.map(call => call[1]?.messages?.[1]?.content).find(text => text === 'do the thing'),
      { timeout: 5000, interval: 5 }
    );
    expect(body).toBe('do the thing');
  });

  it('puts the child in the parent working directory on "Start locally", exactly as before', async () => {
    const before = (await listWorktrees(main)).length;

    const parent = await spawnWith({ decision: 'once', optionId: 'local' });

    expect((await child())?.project).toEqual((await store.get(parent.id))?.project);
    // Nothing was checked out, which is the other half of "exactly as before".
    expect(await listWorktrees(main)).toHaveLength(before);
  });

  it('starts no session at all on "Do it here", and tells the model to get on with it', async () => {
    await spawnWith({ decision: 'redirect', optionId: 'here' });

    expect(await child()).toBeUndefined();

    // Not an error, because an error is what teaches a model to stop and apologise. The text has
    // to read as an instruction to carry on, in this conversation.
    const call = settled()[0];
    expect(call?.status).toBe('done');
    expect(call?.error).toBeUndefined();
    expect(call?.preview).toMatch(/No session was started/);
    expect(call?.preview).toMatch(/not a refusal/);
    expect(call?.preview).toMatch(/do not ask them what they would like instead/);
  });

  it('records no standing approval for "Do it here", so it can never become a policy', async () => {
    // Answering 'always' on a redirect is the malformed case the card cannot produce - it offers
    // no "always" for that option - and the gate has to refuse to record one anyway.
    const parent = await spawnWith({ decision: 'always', optionId: 'here' });

    const key = 'session_spawn:The thing:do the thing';
    expect(approvals.isStanding(parent.id, key, ['here'])).toBeNull();
    expect(approvals.isStanding(parent.id, key)).toBeNull();
    expect(await child()).toBeUndefined();
  });

  it('files a standing approval under the option it was given, and replays that option', async () => {
    const parent = await spawnWith({ decision: 'always', optionId: 'local' }, { prompt: 'same task', title: 'Same' });

    const key = 'session_spawn:Same:same task';
    expect(approvals.isStanding(parent.id, key, ['local'])).toMatchObject({ optionId: 'local' });
    // The same call looked up under the OTHER option finds nothing: a standing "locally" must
    // never be spent on a worktree, which is why the option is part of what it is filed under.
    expect(approvals.isStanding(parent.id, key, ['worktree'])).toBeNull();

    // And an identical repeat replays as local rather than being asked again or upgraded.
    const before = events.length;
    requestSpawn(await awaitStreamOfPrompt('go'), 'call-2', 'same task', 'Same');
    await awaitSettled(2);
    expect(events.slice(before).some(event => event.type === 'tool-start' && event.call.approvalId)).toBe(false);

    const children = (await store.list()).filter(session => session.origin);
    expect(children).toHaveLength(2);
    expect(children.every(entry => entry.project?.workingDirectory === main)).toBe(true);
  });

  it('refuses the parent own branch rather than handing back the parent worktree', async () => {
    // The trap this exists for: resolveWorkspace is keyed on branch, so 'main' would resolve to
    // the checkout the parent is already in, while the row and the chip claimed isolation.
    await spawnWith({ decision: 'once', optionId: 'worktree', value: 'main' });

    expect(await child()).toBeUndefined();
    expect(settled()[0]?.status).toBe('error');
    expect(settled()[0]?.error).toMatch(/this conversation's own branch/);
  });

  it('refuses a branch that already exists rather than adopting its worktree', async () => {
    await git(main, ['branch', 'agent/taken']);

    await spawnWith({ decision: 'once', optionId: 'worktree', value: 'agent/taken' });

    expect(await child()).toBeUndefined();
    expect(settled()[0]?.error).toMatch(/already exists/);
  });

  it('refuses a branch name git would not take', async () => {
    await spawnWith({ decision: 'once', optionId: 'worktree', value: 'not a branch' });

    expect(await child()).toBeUndefined();
    expect(settled()[0]?.error).toMatch(/not a usable branch name/);
  });

  it('leaves no half-made session when the worktree cannot be created', async () => {
    // Something already at the path that git does not know as a worktree: resolveWorkspace refuses
    // it rather than clobbering it, and that refusal has to land BEFORE a session exists.
    await mkdir(join(container, 'agent+blocked'), { recursive: true });
    await writeFile(join(container, 'agent+blocked', 'stray.txt'), 'not mine\n', 'utf8');

    await spawnWith({ decision: 'once', optionId: 'worktree', value: 'agent/blocked' });

    expect(await child()).toBeUndefined();
    expect(settled()[0]?.error).toMatch(/could not be created/);
    // Untouched, which is the other half of refusing rather than adopting.
    expect(await readFile(join(container, 'agent+blocked', 'stray.txt'), 'utf8')).toBe('not mine\n');
  });

  it('keeps the approval-mode ceiling and the depth count on a child in its own worktree', async () => {
    const parent = await parentSession();
    await store.setApprovalMode(parent.id, 'full');
    await service.send(parent.id, 'go');
    await vi.waitUntil(() => streams.length > 0, { timeout: 5000, interval: 5 });
    requestSpawn(streams[0], 'call-1', 'isolated work', 'Isolated');

    // Still asked despite 'full', because session_spawn spends credits - and that is what makes
    // the choice reachable in every mode.
    const card = await awaitCard();
    approvals.resolve(card.approvalId as string, { decision: 'once', optionId: 'worktree', value: 'agent/isolated' });
    await awaitSettled(1);

    const spawned = await child();
    expect(spawned?.approvalMode).toBe('auto');
    expect(spawned?.origin).toMatchObject({ parentSessionId: parent.id, depth: 1 });
  });

  it('offers the three options, worktree first, with only that one carrying a branch', async () => {
    const parent = await parentSession();
    await service.send(parent.id, 'go');
    await vi.waitUntil(() => streams.length > 0, { timeout: 5000, interval: 5 });
    requestSpawn(streams[0], 'call-1', 'tidy the imports', 'Tidy imports');

    const card = await awaitCard();
    const options = card.approvalChoice?.options ?? [];
    expect(options.map(option => option.id)).toEqual(['worktree', 'local', 'here']);
    expect(options[0].field).toMatchObject({ name: 'branch', value: 'agent/tidy-imports' });
    expect(options[1].field).toBeUndefined();
    expect(options[2].redirect).toBe(true);

    approvals.resolve(card.approvalId as string, { decision: 'deny' });
    await awaitSettled(1);
  });
});
