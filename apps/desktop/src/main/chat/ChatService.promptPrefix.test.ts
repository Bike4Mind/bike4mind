import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_ARTIFACT_PROMPT } from './artifacts/prompt';
import { buildSystemMessage, ChatService, MAX_CONCURRENT_SPAWNED, worktreePreamble } from './ChatService';
import { MessageQueue } from './MessageQueue';
import { git } from './project/git';
import { appWorktreeRoot } from './project/workspace';
import { SessionStore } from './SessionStore';
import { TITLE_INSTRUCTION } from './sessionTitle';
import type { AccessStore } from './tools/AccessStore';
import type { ChatStreamEvent } from '@shared/chat';
import { WEB_SEARCH_TURN_BUDGET } from './tools/webSearchLimits';

vi.mock('../git/hostGitArgs', async importOriginal =>
  (await import('./plainFolderGit.testHelper')).skipGitOutsideRepositories(await importOriginal())
);

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

interface Request {
  system: string;
  tools: { toolSchema: { name: string } }[];
  stream: PassThrough;
}

/** The first line on which two prompts part, so a failure names the block that moved. */
function firstDifferingLine(left: string, right: string): string | null {
  const a = left.split('\n');
  const b = right.split('\n');
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] ?? b[index] ?? '';
  }
  return null;
}

/**
 * The cached prefix is tools, then the system prompt, then the conversation: a byte that moves in
 * either of the first two is a rewrite of everything after it. These pin the two places an
 * orchestrated run lost it: the parent's wake, and sibling workers in their own worktrees.
 */
describe('ChatService prompt prefix', () => {
  let base: string;
  let project: string;
  let worktrees: string;
  let store: SessionStore;
  let service: ChatService;
  let requests: Request[];
  let done: string[];

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-prefix-')));
    project = join(base, 'project');
    await mkdir(project, { recursive: true });
    await mkdir(join(base, 'container'), { recursive: true });
    await git(project, ['init', '--quiet', `--separate-git-dir=${join(base, 'container', '.bare')}`]);
    await git(project, [
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=T',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'first',
    ]);
    worktrees = appWorktreeRoot(join(base, 'container'));
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-prefix-sessions-')), 'test-model');
    const opened: Request[] = (requests = []);
    const finished: string[] = (done = []);
    const post = vi
      .fn()
      .mockImplementation(
        (_url: string, body: { messages: { content: unknown }[]; options?: { tools?: Request['tools'] } }) => {
          const stream = new PassThrough();
          const system = body.messages[0]?.content;
          if (system !== TITLE_INSTRUCTION) {
            opened.push({ system: typeof system === 'string' ? system : '', tools: body.options?.tools ?? [], stream });
          }
          return Promise.resolve({ data: stream, status: 200 });
        }
      );
    service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      pullRequests: { bindForAgent: vi.fn(), dismiss: vi.fn() },
      queue: new MessageQueue(() => undefined),
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => {
        if (event.type === 'done') finished.push(event.sessionId);
      },
    });
  });

  afterEach(() => {
    service.dispose();
    for (const request of requests) request.stream.end();
  });

  async function finishTurn(index: number): Promise<void> {
    await vi.waitUntil(() => requests.length > index, { timeout: 5000, interval: 5 });
    requests[index].stream.write(frame({ type: 'content', text: 'ok' }));
    requests[index].stream.write(frame('[DONE]'));
  }

  async function parentSession(): Promise<string> {
    const created = await service.createCodeSession({ directory: project, branch: '', workspace: false });
    if (!created.ok) throw new Error(created.error);
    return created.session.id;
  }

  /** An agent the parent started, in its own worktree under the app's worktree root. */
  async function agentSession(parentSessionId: string, name: string): Promise<string> {
    const folder = join(worktrees, name);
    await mkdir(folder, { recursive: true });
    await store.appendMessage(parentSessionId, {
      id: `spawn-${name}`,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      toolCalls: [{ id: `spawn-${name}`, name: 'session_spawn', input: { prompt: 'do a piece' }, status: 'done' }],
    });
    const agent = await store.create(undefined, {
      mode: 'code',
      project: {
        directory: project,
        name: 'project',
        branch: '',
        workspace: true,
        workspaceBranch: `b4m/${name}`,
        workingDirectory: folder,
        contextDirectories: [],
      },
      origin: { parentSessionId, depth: 1, seedPrompt: 'do a piece' },
    });
    return agent.id;
  }

  it("keeps the parent's tools and system prompt byte-identical from its first turn to an unattended wake", async () => {
    const parent = await parentSession();
    await service.send(parent, 'split this into pieces');
    await finishTurn(0);
    await vi.waitUntil(() => done.includes(parent), { timeout: 5000, interval: 5 });

    // The agents it started now have worktrees the parent may read, which used to join the listing.
    await agentSession(parent, 'agent-a');
    await agentSession(parent, 'agent-b');
    expect(
      await service.startAutomaticTurn(parent, 'agent-a finished', {
        kind: 'background-exit',
        processIds: ['aaaa1111'],
        summary: 'agent-a finished',
      })
    ).toEqual({ ok: true });
    await vi.waitUntil(() => requests.length === 2, { timeout: 5000, interval: 5 });
    const [first, wake] = requests;

    expect(wake.tools.map(tool => tool.toolSchema.name)).toEqual(first.tools.map(tool => tool.toolSchema.name));
    expect(wake.tools.map(tool => tool.toolSchema.name)).toContain('set_session_pull_request');
    expect(JSON.stringify(wake.tools)).toBe(JSON.stringify(first.tools));
    expect(firstDifferingLine(first.system, wake.system)).toBeNull();
    expect(wake.system).not.toContain(worktrees);
  });

  it('gives sibling agents in different worktrees one system prefix through the shared guidance', async () => {
    const parent = await parentSession();
    const left = await agentSession(parent, 'agent-left');
    const right = await agentSession(parent, 'agent-right');
    await service.send(left, 'do the left piece');
    await finishTurn(0);
    await service.send(right, 'do the right piece');
    await vi.waitUntil(() => requests.length === 2, { timeout: 5000, interval: 5 });
    const [a, b] = requests;

    expect(JSON.stringify(b.tools)).toBe(JSON.stringify(a.tools));
    expect(firstDifferingLine(a.system, b.system)).toMatch(/^Commands run in /);
    const shared = a.system.slice(0, a.system.indexOf('This conversation is about the project '));
    expect(b.system.startsWith(shared)).toBe(true);
    expect(shared).toContain(DESKTOP_ARTIFACT_PROMPT);
    expect(shared).not.toContain(worktrees);
  });

  it('splits the system prompt where the per-session lines start, so siblings cache one shared half', () => {
    const agent = (name: string) =>
      buildSystemMessage(
        [join(worktrees, name)],
        false,
        true,
        false,
        null,
        {
          directory: project,
          name: 'project',
          branch: '',
          workspace: true,
          workspaceBranch: `b4m/${name}`,
          workingDirectory: join(worktrees, name),
          contextDirectories: [],
        },
        [],
        'Files in the working directory:\na.ts'
      );
    const [left, right] = [agent('agent-left'), agent('agent-right')];
    const halves = (message: typeof left) => {
      const content = message.content as string;
      return [content.slice(0, message.cacheSplitAt), content.slice(message.cacheSplitAt)];
    };
    const [leftShared, leftTail] = halves(left);
    const [rightShared, rightTail] = halves(right);

    expect(leftShared).toBe(rightShared);
    expect(leftShared).toContain('Files in the working directory:');
    expect(leftShared).not.toContain(worktrees);
    expect(leftTail).toMatch(/^This conversation is about the project /);
    expect(leftTail).not.toBe(rightTail);
  });
});

describe('projectContext', () => {
  function frame(payload: unknown): string {
    return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
  }

  describe('ChatService project context', () => {
    let service: ChatService;
    let events: ChatStreamEvent[];
    let post: ReturnType<typeof vi.fn>;
    let streams: PassThrough[];
    let project: string;
    let userRoot: string;

    beforeEach(async () => {
      project = await realpath(await mkdtemp(join(tmpdir(), 'b4m-projctx-')));
      userRoot = await realpath(await mkdtemp(join(tmpdir(), 'b4m-projctx-user-')));
      await writeFile(join(project, 'CLAUDE.md'), 'Always update the nav map.', 'utf8');
      await writeFile(join(project, 'first.ts'), 'x', 'utf8');

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
      service = new ChatService({
        store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-projctx-sessions-')), 'test-model'),
        access: { list: async () => [] } as unknown as AccessStore,
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: () =>
          ({
            get: vi.fn().mockResolvedValue({}),
            getAxiosInstance: () => ({ post: boundPost }),
          }) as unknown as AuthenticatedApiClient,
        getEnvironmentUrl: () => 'http://localhost:3000',
        userInstructionsRoot: userRoot,
        emit: event => emitted.push(event),
      });
    });

    async function reply(sessionId: string, text: string, expectedPosts: number): Promise<void> {
      await service.send(sessionId, text);
      await vi.waitUntil(() => post.mock.calls.length === expectedPosts, { timeout: 3000, interval: 5 });
      const stream = streams[expectedPosts - 1];
      stream.write(frame({ type: 'content', text: 'ok', stopReason: 'end_turn' }));
      stream.write(frame('[DONE]'));
      await vi.waitUntil(() => events.filter(event => event.type === 'done').length === expectedPosts, {
        timeout: 3000,
        interval: 5,
      });
    }

    it('puts the instructions and tree in the system message and keeps it identical on the next turn', async () => {
      const created = await service.createCodeSession({ directory: project, branch: '', workspace: false });
      if (!created.ok) throw new Error(created.error);
      const id = created.session.id;

      await reply(id, 'first', 1);
      const first = post.mock.calls[0][1].messages[0];
      expect(first.role).toBe('system');
      expect(first.content).toContain('Always update the nav map.');
      expect(first.content).toContain('must be followed');
      expect(first.content).toContain('first.ts');
      expect(first.content).toContain('do not list the root');

      await writeFile(join(project, 'created-mid-session.ts'), 'x', 'utf8');
      await writeFile(join(project, 'CLAUDE.md'), 'Changed rules.', 'utf8');
      await reply(id, 'second', 2);

      expect(post.mock.calls[1][1].messages[0]).toEqual(first);
      expect(first.content).not.toContain('created-mid-session.ts');
    });

    it('leaves a session with no project and no user file untouched', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'hi');
      await vi.waitUntil(() => post.mock.calls.length === 1, { timeout: 3000, interval: 5 });
      expect(post.mock.calls[0][1].messages[0].content).not.toContain('instructions that apply');
    });

    it('gives a Chat session with no project the user instructions, which it had none of before', async () => {
      await writeFile(join(userRoot, 'CLAUDE.md'), 'Sign off every reply with a tilde.', 'utf8');
      const { id } = await service.createSession();
      await service.send(id, 'hi');
      await vi.waitUntil(() => post.mock.calls.length === 1, { timeout: 3000, interval: 5 });
      const system = post.mock.calls[0][1].messages[0].content;
      expect(system).toContain('Sign off every reply with a tilde.');
      expect(system).toContain(join(userRoot, 'CLAUDE.md'));
    });

    it('puts the user instructions above the project ones in a Code session', async () => {
      await writeFile(join(userRoot, 'CLAUDE.md'), 'User standing rule.', 'utf8');
      const created = await service.createCodeSession({ directory: project, branch: '', workspace: false });
      if (!created.ok) throw new Error(created.error);

      await reply(created.session.id, 'first', 1);
      const system: string = post.mock.calls[0][1].messages[0].content;
      expect(system.indexOf('User standing rule.')).toBeLessThan(system.indexOf('Always update the nav map.'));
    });
  });
});

describe('gptGuidance', () => {
  const build = (modelId: string): string =>
    String(
      buildSystemMessage(['/work'], false, false, false, [], undefined, [], '', false, false, false, '', true, modelId)
        .content
    );

  describe('GPT_GUIDANCE', () => {
    it('is included for a gpt model id, case-insensitively', () => {
      expect(build('gpt-5')).toContain('Keep going until the task is fully handled');
      expect(build('GPT-5-codex')).toContain('Keep going until the task is fully handled');
    });

    it('is left out for other models', () => {
      expect(build('claude-sonnet-4')).not.toContain('Keep going until the task is fully handled');
    });
  });
});

describe('webGuidance', () => {
  const build = (roots: string[], web: boolean): string =>
    String(
      buildSystemMessage(roots, false, false, false, [], undefined, [], '', false, false, false, '', true, '', web)
        .content
    );

  describe('WEB_GUIDANCE', () => {
    it.each([[['/work']], [[]]])('steers searches toward one query at a time (roots %j)', roots => {
      const text = build(roots, true);
      expect(text).toContain('Search with one well-formed query first, read the results, then refine');
      expect(text).toContain(`A turn allows at most ${WEB_SEARCH_TURN_BUDGET} searches`);
    });

    it('is left out when the web tools are not declared', () => {
      expect(build(['/work'], false)).not.toContain('well-formed query');
    });
  });
});

describe('planGuidance', () => {
  const build = (roots: string[], plan: boolean): string =>
    String(
      buildSystemMessage(
        roots,
        false,
        false,
        false,
        [],
        undefined,
        [],
        '',
        false,
        false,
        false,
        '',
        true,
        '',
        false,
        false,
        false,
        false,
        plan
      ).content
    );

  describe('PLAN_GUIDANCE', () => {
    it.each([[['/work']], [[]]])('steers todo_write use with or without a folder (roots %j)', roots => {
      expect(build(roots, true)).toContain('Keep one with todo_write only when');
    });

    // A model without tools, or one whose tools were shed to fit a fixed context, has no todo_write.
    it.each([[['/work']], [[]]])('is left out when todo_write is not declared (roots %j)', roots => {
      expect(build(roots, false)).not.toContain('todo_write');
    });
  });
});

describe('orchestratorGuidance', () => {
  const build = (roots: string[], host: boolean, orchestrate: boolean): string =>
    String(
      buildSystemMessage(
        roots,
        false,
        host,
        false,
        [],
        undefined,
        [],
        '',
        false,
        false,
        false,
        '',
        true,
        '',
        false,
        false,
        false,
        orchestrate
      ).content
    );

  describe('ORCHESTRATOR_GUIDANCE', () => {
    it.each([[['/work']], [[]]])('steers an orchestrating session to delegate (roots %j)', roots => {
      const text = build(roots, true, true);
      expect(text).toContain('you are coordinating agents');
      expect(text).toContain(`At most ${MAX_CONCURRENT_SPAWNED} agents run at once`);
    });

    it('is left out when the session does not orchestrate', () => {
      expect(build(['/work'], true, false)).not.toContain('coordinating agents');
    });

    it('is left out without the host tools, which are what it would steer toward', () => {
      expect(build(['/work'], false, true)).not.toContain('coordinating agents');
      expect(build([], false, true)).not.toContain('coordinating agents');
    });
  });

  describe('worktreePreamble', () => {
    it('tells a spawned agent to keep off the shared git stash', () => {
      const text = worktreePreamble('/repo', { branch: 'agent/x', base: 'main', workingDirectory: '/wt/x' });
      expect(text).toContain('Never use git stash');
      expect(text).toContain('shared by every worktree');
      expect(text.endsWith(']')).toBe(true);
    });
  });
});
