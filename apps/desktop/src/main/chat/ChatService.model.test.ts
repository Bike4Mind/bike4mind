import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatModelOption } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import type { ModelCatalog } from './ModelCatalog';
import type { ModelMemory } from './ModelPreference';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { TITLE_INSTRUCTION } from './sessionTitle';

const HOSTED: ChatModelOption[] = [
  { id: 'claude-sonnet-4-5-20250929', name: 'Claude 4.5 Sonnet', backend: 'anthropic' },
  { id: 'gpt-4o', name: 'GPT-4o', backend: 'openai' },
];

/** What a self-host stack with only a local Ollama looks like: no Anthropic key, no Claude. */
const SELF_HOST: ChatModelOption[] = [{ id: 'qwen3.5', name: 'qwen3.5', backend: 'ollama' }];

/** The turn's own request, not the title request that a first message also sends. */
function turnRequest(post: ReturnType<typeof vi.fn>): Record<string, unknown> | undefined {
  return post.mock.calls
    .map(call => call[1] as { messages: { content: unknown }[] })
    .find(body => body.messages[0]?.content !== TITLE_INSTRUCTION);
}

describe('ChatService model selection', () => {
  let store: SessionStore;
  let available: ChatModelOption[];
  let post: ReturnType<typeof vi.fn>;
  let service: ChatService;
  let remembered: string | null;
  let memory: ModelMemory & { record: ReturnType<typeof vi.fn<ModelMemory['record']>> };

  beforeEach(async () => {
    remembered = null;
    memory = {
      read: async () => remembered,
      record: vi.fn<ModelMemory['record']>(async (model: string) => {
        remembered = model;
      }),
    };
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
      modelMemory: memory,
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

  it('starts the next conversation on the model the user last picked', async () => {
    const { id } = await service.createSession();
    await service.setSessionModel(id, 'gpt-4o');

    expect(memory.record).toHaveBeenCalledWith('gpt-4o');
    expect(await service.createSession()).toMatchObject({ model: 'gpt-4o' });
    const code = await service.createCodeSession({});
    expect(code.ok && code.session.model).toBe('gpt-4o');
  });

  it('falls back to the built-in default, without forgetting, when the pick is not offered here', async () => {
    remembered = 'gpt-5.5';

    expect(await service.createSession()).toMatchObject({ model: 'claude-sonnet-4-5-20250929' });
    expect(remembered).toBe('gpt-5.5');
    expect(memory.record).not.toHaveBeenCalled();

    available = [...HOSTED, { id: 'gpt-5.5', name: 'GPT-5.5', backend: 'openai' }];
    expect(await service.createSession()).toMatchObject({ model: 'gpt-5.5' });
  });

  it('falls back to the first listed model when neither the pick nor the default is offered', async () => {
    remembered = 'gpt-4o';
    available = SELF_HOST;
    expect(await service.createSession()).toMatchObject({ model: 'qwen3.5' });
    expect(remembered).toBe('gpt-4o');
  });

  it('leaves existing conversations on their own model when the user picks elsewhere', async () => {
    const old = await service.createSession();
    const { id } = await service.createSession();
    await service.setSessionModel(id, 'gpt-4o');

    expect((await service.getSession(old.id))?.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('does not remember a pick for a conversation that does not exist', async () => {
    expect(await service.setSessionModel('no-such-session', 'gpt-4o')).toBeNull();
    expect(memory.record).not.toHaveBeenCalled();
  });

  it('keeps the switch when the pick cannot be remembered', async () => {
    memory.record.mockRejectedValueOnce(new Error('disk full'));
    const { id } = await service.createSession();

    expect(await service.setSessionModel(id, 'gpt-4o')).toMatchObject({ model: 'gpt-4o' });
  });

  it('sends the conversation model, not the default', async () => {
    const { id } = await service.createSession();
    await service.setSessionModel(id, 'gpt-4o');

    await service.send(id, 'hello');
    await vi.waitUntil(() => post.mock.calls.length > 0, { timeout: 2000, interval: 5 });

    expect(post.mock.calls[0][1]).toMatchObject({ model: 'gpt-4o' });
  });

  it("asks for the model's own output ceiling, so a long file write is not cut off at 4096", async () => {
    available = [{ id: 'gpt-4o', name: 'GPT-4o', maxOutputTokens: 16_384 }];
    const { id } = await service.createSession();
    await service.setSessionModel(id, 'gpt-4o');

    await service.send(id, 'hello');
    const turn = await vi.waitUntil(() => turnRequest(post), { timeout: 2000, interval: 5 });

    expect(turn).toMatchObject({ model: 'gpt-4o', max_tokens: 16_384 });
  });

  it('leaves max_tokens to the server when the catalog does not state a ceiling', async () => {
    const { id } = await service.createSession();
    await service.setSessionModel(id, 'gpt-4o');

    await service.send(id, 'hello');
    const turn = await vi.waitUntil(() => turnRequest(post), { timeout: 2000, interval: 5 });

    expect(turn).not.toHaveProperty('max_tokens');
  });

  // Switching environments is the everyday way in: hosted's Claude is not on a keyless self-host.
  it('moves a conversation off a model this deployment no longer offers, and says so', async () => {
    const { id } = await service.createSession();
    available = SELF_HOST;

    const accepted = await service.send(id, 'hello');

    expect(accepted).toMatchObject({ ok: true });
    expect(accepted.ok && !accepted.queued && accepted.notice).toMatch(/not available on this server/i);
    expect((await service.getSession(id))?.model).toBe('qwen3.5');

    await vi.waitUntil(() => post.mock.calls.length > 0, { timeout: 2000, interval: 5 });
    expect(post.mock.calls[0][1]).toMatchObject({ model: 'qwen3.5' });
  });

  it('moves a stranded conversation to the remembered pick, and does not record that as a pick', async () => {
    const { id } = await service.createSession();
    available = [...SELF_HOST, { id: 'gpt-4o', name: 'GPT-4o', backend: 'openai' }];
    remembered = 'gpt-4o';

    await service.send(id, 'hello');

    expect((await service.getSession(id))?.model).toBe('gpt-4o');
    expect(memory.record).not.toHaveBeenCalled();
  });

  it('does not let the automatic replacement overwrite the pick', async () => {
    remembered = 'gpt-4o';
    const { id } = await service.createSession();
    available = SELF_HOST;

    await service.send(id, 'hello');

    expect((await service.getSession(id))?.model).toBe('qwen3.5');
    expect(memory.record).not.toHaveBeenCalled();
    expect(remembered).toBe('gpt-4o');
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
