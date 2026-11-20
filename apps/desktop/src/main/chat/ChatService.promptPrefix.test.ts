import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_ARTIFACT_PROMPT } from './artifacts/prompt';
import { ChatService, buildSystemMessage } from './ChatService';
import { MessageQueue } from './MessageQueue';
import { git } from './project/git';
import { appWorktreeRoot } from './project/workspace';
import { SessionStore } from './SessionStore';
import { TITLE_INSTRUCTION } from './sessionTitle';
import type { AccessStore } from './tools/AccessStore';

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
