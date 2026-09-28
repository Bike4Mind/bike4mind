import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatModelOption } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import type { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

const HOSTED: ChatModelOption[] = [
  { id: 'claude-sonnet-4-5-20250929', name: 'Claude 4.5 Sonnet', backend: 'anthropic' },
  { id: 'gpt-4o', name: 'GPT-4o', backend: 'openai' },
];

/** What a self-host stack with only a local Ollama looks like: no Anthropic key, no Claude. */
const SELF_HOST: ChatModelOption[] = [{ id: 'qwen3.5', name: 'qwen3.5', backend: 'ollama' }];

describe('ChatService model selection', () => {
  let store: SessionStore;
  let available: ChatModelOption[];
  let post: ReturnType<typeof vi.fn>;
  let service: ChatService;

  beforeEach(async () => {
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-model-')), 'preferred-model');
    available = HOSTED;
    post = vi.fn().mockResolvedValue({ data: new PassThrough(), status: 200 });

    const models = {
      list: async () => ({ models: available }),
      cached: () => available,
    } as unknown as ModelCatalog;

    service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      models,
      preferredModel: 'claude-sonnet-4-5-20250929',
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: async () => ({ sseCompletionsUrl: '' }),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: () => {},
    });
  });

  it('starts a conversation on the preferred model when the server offers it', async () => {
    expect(await service.createSession()).toMatchObject({ model: 'claude-sonnet-4-5-20250929' });
  });

  it('starts on what the server does offer when the preferred model is absent', async () => {
    available = SELF_HOST;
    expect(await service.createSession()).toMatchObject({ model: 'qwen3.5' });
  });

  it('remembers the choice per conversation, so reopening resumes the model it was using', async () => {
    const { id } = await service.createSession();
    const other = await service.createSession();

    await service.setSessionModel(id, 'gpt-4o');

    expect((await service.getSession(id))?.model).toBe('gpt-4o');
    expect((await service.getSession(other.id))?.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('sends the conversation model, not the default', async () => {
    const { id } = await service.createSession();
    await service.setSessionModel(id, 'gpt-4o');

    await service.send(id, 'hello');
    await vi.waitUntil(() => post.mock.calls.length > 0, { timeout: 2000, interval: 5 });

    expect(post.mock.calls[0][1]).toMatchObject({ model: 'gpt-4o' });
  });

  // Switching environments is the everyday way in: hosted's Claude is not on a keyless self-host.
  it('moves a conversation off a model this deployment no longer offers, and says so', async () => {
    const { id } = await service.createSession();
    available = SELF_HOST;

    const accepted = await service.send(id, 'hello');

    expect(accepted).toMatchObject({ ok: true });
    expect(accepted.ok && accepted.notice).toMatch(/not available on this server/i);
    expect((await service.getSession(id))?.model).toBe('qwen3.5');

    await vi.waitUntil(() => post.mock.calls.length > 0, { timeout: 2000, interval: 5 });
    expect(post.mock.calls[0][1]).toMatchObject({ model: 'qwen3.5' });
  });

  // An unreadable catalog says nothing about what the server has; guessing would be worse.
  it('sends the saved model unchanged when no list is cached', async () => {
    const { id } = await service.createSession();
    await service.setSessionModel(id, 'some-retired-model');
    available = [];

    const accepted = await service.send(id, 'hello');

    expect(accepted).toEqual({ ok: true, messageId: expect.any(String) });
    await vi.waitUntil(() => post.mock.calls.length > 0, { timeout: 2000, interval: 5 });
    expect(post.mock.calls[0][1]).toMatchObject({ model: 'some-retired-model' });
  });
});
