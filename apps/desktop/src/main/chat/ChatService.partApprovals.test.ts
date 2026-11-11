import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatApprovalMode, ChatProject, ChatStreamEvent, ChatToolCall } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import type { ClaudeCodeSettings } from './permissions/ClaudeCodeSettings';
import { PermissionRuleStore } from './permissions/PermissionRuleStore';
import { PermissionService } from './permissions/PermissionService';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';
import { mainCheckoutOf } from './tools/shellTools';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore' });
};

/** A chain's sub-commands are decided one by one, and a card asks only about the ones still undecided. */
describe('ChatService approvals decided per part', () => {
  let service: ChatService;
  let approvals: ApprovalGate;
  let permissions: PermissionService;
  let store: SessionStore;
  let rulesFile: string;
  let events: ChatStreamEvent[];
  let streams: PassThrough[];
  let root: string;
  let main: string;
  let worktree: string;
  let other: string;

  const calls = (name: string, status: ChatToolCall['status']): ChatToolCall[] =>
    events
      .map(event => (event.type === 'tool-start' || event.type === 'tool-end' ? event.call : null))
      .filter((call): call is ChatToolCall => call !== null && call.name === name && call.status === status);

  const awaitCall = (name: string, status: ChatToolCall['status']) =>
    vi.waitUntil(() => calls(name, status)[0], { timeout: 5000, interval: 10 });

  const settled = () =>
    vi.waitUntil(() => calls('bash_execute', 'done')[0] ?? calls('bash_execute', 'error')[0], {
      timeout: 5000,
      interval: 10,
    });

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-parts-')));
    main = join(root, 'repo');
    worktree = join(root, 'repo-wt');
    other = join(root, 'other');
    await mkdir(main);
    await mkdir(other);
    git(main, 'init', '-q');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'x');
    git(main, 'worktree', 'add', '-q', worktree);

    rulesFile = join(root, 'permission-rules.json');
    approvals = new ApprovalGate();
    permissions = new PermissionService({
      store: new PermissionRuleStore(rulesFile),
      claudeCode: {
        loadUser: async () => {},
        loadProject: async () => {},
        filesFor: () => [],
        allFiles: () => [],
        dispose: () => {},
      } as unknown as ClaudeCodeSettings,
      isTrusted: async () => true,
      home: join(root, 'home'),
      protectedRoots: [],
      mainCheckoutOf,
      logger: { warn: vi.fn() },
    });
    await permissions.setShareClaudeCode(false);
    const testEvents: ChatStreamEvent[] = [];
    const testStreams: PassThrough[] = [];
    events = testEvents;
    streams = testStreams;
    const post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      testStreams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-parts-sessions-')), 'test-model');
    service = new ChatService({
      store,
      access: { list: async () => [root] } as unknown as AccessStore,
      approvals,
      permissions,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          post: vi.fn().mockResolvedValue({ result: 'page' }),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => testEvents.push(event),
    });
  });

  afterEach(() => {
    service.dispose();
    for (const stream of streams) stream.end();
    vi.restoreAllMocks();
  });

  const project = (directory: string): ChatProject => ({
    directory,
    name: basename(directory),
    branch: '',
    workspace: false,
    workingDirectory: directory,
    contextDirectories: [],
  });

  async function session(
    mode: ChatApprovalMode,
    directory: string | null = null,
    parentSessionId?: string
  ): Promise<string> {
    const created = await store.create('test-model', {
      ...(directory ? { project: project(directory) } : {}),
      ...(parentSessionId ? { origin: { parentSessionId, depth: 1, seedPrompt: 'work' } } : {}),
    });
    await service.setApprovalMode(created.id, mode);
    return created.id;
  }

  /** Starts a reply whose single round runs `command`; returns its first stream's index. */
  async function runCommand(sessionId: string, command: string, cwd = root): Promise<number> {
    const before = streams.length;
    await service.send(sessionId, 'go');
    await vi.waitUntil(() => streams.length === before + 1, { timeout: 5000, interval: 5 });
    streams[before].write(
      frame({
        type: 'tool_use',
        tools: [{ id: `c${before}`, name: 'bash_execute', arguments: JSON.stringify({ command, cwd }) }],
      })
    );
    streams[before].write(frame('[DONE]'));
    return before;
  }

  /** Ends the reply that started at stream `first` once its call has settled and the model is asked again. */
  async function finishReply(first: number): Promise<void> {
    await settled();
    const done = events.filter(event => event.type === 'done').length;
    await vi.waitUntil(() => streams.length > first + 1, { timeout: 5000, interval: 5 });
    streams[first + 1].write(frame({ type: 'content', text: 'ok', stopReason: 'end_turn' }));
    streams[first + 1].write(frame('[DONE]'));
    await vi.waitUntil(() => events.filter(event => event.type === 'done').length > done, {
      timeout: 5000,
      interval: 5,
    });
    events.length = 0;
  }

  it('names only the unreadable part of a chain in auto mode, and scopes "always" to it', async () => {
    const id = await session('auto');
    await runCommand(id, 'git status && node -e 1');

    const card = await awaitCall('bash_execute', 'awaiting-approval');
    expect(card.approvalParts).toEqual([{ text: 'node -e 1', reason: 'Can send data off this computer (node -e).' }]);
    expect(card.approvalAlways ?? '').not.toContain('git status');
  });

  it('asks only about the parts no rule covers, and "Allow in this chat" covers just those', async () => {
    await permissions.setRules({ kind: 'user' }, { allow: ['Bash(git status:*)'], ask: [], deny: [] });
    const id = await session('ask');
    const first = await runCommand(id, 'git status && printf ok');

    const card = await awaitCall('bash_execute', 'awaiting-approval');
    expect(card.approvalParts?.map(part => part.text)).toEqual(['printf ok']);
    expect(card.approvalAlways).toBe('`printf *`');
    expect(card.approvalRules).toEqual(['Bash(printf:*)']);
    approvals.resolve(card.approvalId!, { decision: 'always' });
    await finishReply(first);

    await runCommand(id, 'git status && printf other');
    const ran = await settled();
    expect(ran.approval?.decidedBy).toEqual({ kind: 'chat-allowance' });
    expect(calls('bash_execute', 'awaiting-approval')).toHaveLength(0);
  });

  it('runs a fully covered chain, a read inside a substitution included, without a card', async () => {
    await permissions.setRules(
      { kind: 'user' },
      { allow: ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git merge-base:*)'], ask: [], deny: [] }
    );
    const id = await session('ask');
    await runCommand(id, 'git status && git diff $(git merge-base origin/main HEAD)..HEAD');

    const ran = await settled();
    expect(ran.approval?.decidedBy).toMatchObject({ kind: 'rule' });
    expect(calls('bash_execute', 'awaiting-approval')).toHaveLength(0);
  });

  it('still asks about a folder outside the shared ones when every part is covered', async () => {
    const id = await session('auto');
    // Not the temp folder, which the scan counts as shared.
    await runCommand(id, 'git status && ls /usr/share');

    const card = await awaitCall('bash_execute', 'awaiting-approval');
    expect(card.approvalAlways).toContain('*');
    expect(card.approvalParts).toBeUndefined();
  });

  it('keeps "Allow in this project" for every session of the repository, worktrees and workers included', async () => {
    const asker = await session('ask', worktree);
    const asked = await runCommand(asker, 'printf ok', worktree);
    const card = await awaitCall('bash_execute', 'awaiting-approval');
    expect(card.approvalProjectRules).toEqual(['Bash(printf:*)']);
    expect(card.approvalProject).toBe(main);
    approvals.resolve(card.approvalId!, { decision: 'always', project: true });
    const first = await settled();
    expect(first.approval?.decidedBy).toMatchObject({ kind: 'user', answer: 'always', project: true });
    await finishReply(asked);

    const saved = JSON.parse(await readFile(rulesFile, 'utf8')) as { projects: Record<string, { allow: string[] }> };
    expect(saved.projects[main]?.allow).toEqual(['Bash(printf:*)']);

    const fresh = await session('ask', main);
    const again = await runCommand(fresh, 'printf again', main);
    expect((await settled()).approval?.decidedBy).toMatchObject({ kind: 'rule', rule: 'Bash(printf:*)' });
    await finishReply(again);

    const worker = await session('ask', worktree, fresh);
    const working = await runCommand(worker, 'printf worker', worktree);
    expect((await settled()).approval?.decidedBy).toMatchObject({ kind: 'rule', rule: 'Bash(printf:*)' });
    await finishReply(working);

    const elsewhere = await session('ask', other);
    await runCommand(elsewhere, 'printf other', other);
    await awaitCall('bash_execute', 'awaiting-approval');
  });

  it('never offers "Allow in this project" for a one-off command that only an exact rule could name', async () => {
    const asker = await session('ask', main);
    await runCommand(asker, 'node -e 1', main);
    const card = await awaitCall('bash_execute', 'awaiting-approval');
    expect(card.approvalProjectRules).toBeUndefined();
  });

  it("lets a spawned worker run what its parent allowed in the chat, and nobody else's", async () => {
    const parent = await session('ask');
    const asked = await runCommand(parent, 'printf parent');
    const card = await awaitCall('bash_execute', 'awaiting-approval');
    approvals.resolve(card.approvalId!, { decision: 'always' });
    await finishReply(asked);

    const worker = await session('ask', null, parent);
    const working = await runCommand(worker, 'printf worker');
    expect((await settled()).approval?.decidedBy).toEqual({ kind: 'chat-allowance' });
    await finishReply(working);

    const stranger = await session('ask');
    await runCommand(stranger, 'printf stranger');
    await awaitCall('bash_execute', 'awaiting-approval');
  });
});
