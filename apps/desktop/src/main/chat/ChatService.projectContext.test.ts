import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatStreamEvent } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

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

    events = [];
    streams = [];
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    service = new ChatService({
      store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-projctx-sessions-')), 'test-model'),
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      userInstructionsRoot: userRoot,
      emit: event => events.push(event),
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
