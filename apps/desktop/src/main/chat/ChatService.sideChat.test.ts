import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatSession } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import type { ModelMemory } from './ModelPreference';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

describe('ChatService.startSideChat', () => {
  let store: SessionStore;
  let service: ChatService;
  let post: ReturnType<typeof vi.fn>;
  let project: string;

  beforeEach(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'b4m-side-chat-')));
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-side-chat-sessions-')), 'test-model');
    post = vi.fn();
    const modelMemory: ModelMemory = { read: async () => null, record: async () => {} };
    service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      modelMemory,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: () => undefined,
    });
  });

  async function chatParent(): Promise<ChatSession> {
    const created = await store.create('test-model');
    await store.appendMessage(created.id, {
      id: 'u1',
      role: 'user',
      content: 'What is a monad?',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const stored = await store.appendMessage(created.id, {
      id: 'a1',
      role: 'assistant',
      content: 'A monoid in the category of endofunctors.',
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    return stored!;
  }

  it('starts a child of the conversation, opening with the passage and an excerpt', async () => {
    const parent = await chatParent();
    const result = await service.startSideChat({ sessionId: parent.id, selection: ' category of endofunctors ' });
    if (!result.ok) throw new Error(result.error);

    expect(result.session.origin).toEqual({
      parentSessionId: parent.id,
      depth: 1,
      seedPrompt: 'category of endofunctors',
    });
    expect(result.session.mode).toBe('chat');

    const child = await store.get(result.session.id);
    expect(child?.messages).toHaveLength(1);
    const [opening] = child!.messages;
    expect(opening).toMatchObject({
      role: 'user',
      system: true,
      display: '> category of endofunctors',
      sideChatOf: { sessionId: parent.id, title: parent.title },
    });
    expect(opening.content).toContain('User: What is a monad?');
    expect(opening.content).toContain('> category of endofunctors');
  });

  it('leaves the parent untouched and starts no turn', async () => {
    const parent = await chatParent();
    await service.startSideChat({ sessionId: parent.id, selection: 'monoid' });
    expect((await store.get(parent.id))?.messages).toEqual(parent.messages);
    expect(post).not.toHaveBeenCalled();
  });

  it("shares a Code parent's checkout rather than cutting a worktree", async () => {
    const created = await service.createCodeSession({ directory: project, branch: '', workspace: false });
    if (!created.ok) throw new Error(created.error);
    const result = await service.startSideChat({ sessionId: created.session.id, selection: 'this line' });
    if (!result.ok) throw new Error(result.error);
    expect(result.session.mode).toBe('code');
    expect(result.session.project).toEqual(created.session.project);
  });

  it('refuses an empty highlight, an unknown conversation and one at the nesting limit', async () => {
    const parent = await chatParent();
    expect(await service.startSideChat({ sessionId: parent.id, selection: '   ' })).toMatchObject({ ok: false });
    expect(await service.startSideChat({ sessionId: '00000000-0000-4000-8000-000000000000', selection: 'x' })).toEqual({
      ok: false,
      error: 'That conversation no longer exists.',
    });

    const first = await service.startSideChat({ sessionId: parent.id, selection: 'a' });
    if (!first.ok) throw new Error(first.error);
    const second = await service.startSideChat({ sessionId: first.session.id, selection: 'b' });
    if (!second.ok) throw new Error(second.error);
    const third = await service.startSideChat({ sessionId: second.session.id, selection: 'c' });
    expect(third).toMatchObject({ ok: false });
  });
});
