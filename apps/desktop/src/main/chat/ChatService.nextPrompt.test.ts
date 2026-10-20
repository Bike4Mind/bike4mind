import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatModelOption } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import type { ModelCatalog } from './ModelCatalog';
import { SUGGESTION_INSTRUCTION, SUGGESTION_MODELS } from './nextPrompt';
import { SessionStore } from './SessionStore';
import { TITLE_INSTRUCTION } from './sessionTitle';
import type { AccessStore } from './tools/AccessStore';

const SESSION_MODEL = 'claude-opus-4-5-20251101';
const LOCAL_MODEL = 'qwen3:8b';

const CATALOG: ChatModelOption[] = [
  { id: SESSION_MODEL, name: 'Claude 4.5 Opus', backend: 'anthropic' },
  { id: SUGGESTION_MODELS[0], name: 'Claude 4.5 Haiku', backend: 'anthropic' },
  { id: LOCAL_MODEL, name: 'qwen3:8b', backend: 'ollama' },
];

type WireRequest = { model: string; messages: { role: string; content: unknown }[] };

const frame = (payload: unknown) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;

describe('ChatService next-prompt model', () => {
  let service: ChatService;
  let streams: PassThrough[];
  let post: ReturnType<typeof vi.fn>;
  let cachedModels: ChatModelOption[] | null;
  let listModels: ReturnType<typeof vi.fn>;

  const indexOf = (instruction: string | null) =>
    post.mock.calls.findIndex(call => {
      const first = (call[1] as WireRequest).messages[0]?.content;
      return instruction ? first === instruction : first !== TITLE_INSTRUCTION && first !== SUGGESTION_INSTRUCTION;
    });

  async function answer(instruction: string | null, text: string): Promise<WireRequest> {
    await vi.waitUntil(() => indexOf(instruction) >= 0, { timeout: 5000, interval: 5 });
    const index = indexOf(instruction);
    streams[index].write(frame({ type: 'content', text }));
    streams[index].write(frame('[DONE]'));
    return post.mock.calls[index][1] as WireRequest;
  }

  async function settledSession(): Promise<string> {
    const { id } = await service.createSession();
    await service.send(id, 'Refactor the parser');
    await answer(null, 'Done. Want tests next?');
    await vi.waitUntil(
      async () => (await service.getSession(id))?.messages.at(-1)?.content === 'Done. Want tests next?',
      {
        timeout: 5000,
        interval: 5,
      }
    );
    return id;
  }

  beforeEach(async () => {
    cachedModels = CATALOG;
    listModels = vi.fn().mockResolvedValue({ models: CATALOG });
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-next-prompt-')), SESSION_MODEL);
    const ownStreams: PassThrough[] = (streams = []);
    const ownPost = (post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      ownStreams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    }));
    service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      models: { list: listModels, cached: () => cachedModels } as unknown as ModelCatalog,
      preferredModel: SESSION_MODEL,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: async () => ({ sseCompletionsUrl: '' }),
          getAxiosInstance: () => ({ post: ownPost }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: () => {},
      summaryChanged: () => {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks the local model the user pinned in Settings', async () => {
    const id = await settledSession();
    const pending = service.suggestNextPrompt(id, LOCAL_MODEL);

    const request = await answer(SUGGESTION_INSTRUCTION, 'Add tests for the parser');

    expect(request.model).toBe(LOCAL_MODEL);
    expect(await pending).toBe('Add tests for the parser');
  });

  it('keeps the automatic pick when nothing is pinned', async () => {
    const id = await settledSession();
    const pending = service.suggestNextPrompt(id);

    expect((await answer(SUGGESTION_INSTRUCTION, 'Add tests')).model).toBe(SUGGESTION_MODELS[0]);
    await pending;
  });

  it('suggests nothing, rather than another model, when the pinned one is gone', async () => {
    const id = await settledSession();

    expect(await service.suggestNextPrompt(id, 'llama3.2:1b')).toBeNull();
    expect(indexOf(SUGGESTION_INSTRUCTION)).toBe(-1);
  });

  it('offers the small hosted models first, then the local ones, for the Settings picker', async () => {
    expect((await service.listSuggestionModels()).models.map(model => model.id)).toEqual([
      SUGGESTION_MODELS[0],
      LOCAL_MODEL,
    ]);
    expect(listModels).toHaveBeenLastCalledWith(true);
  });

  it('refreshes an expired catalog before resolving the pinned model', async () => {
    const id = await settledSession();
    cachedModels = null;
    listModels.mockClear();
    const pending = service.suggestNextPrompt(id, LOCAL_MODEL);
    expect((await answer(SUGGESTION_INSTRUCTION, 'Add tests')).model).toBe(LOCAL_MODEL);
    expect(await pending).toBe('Add tests');
    expect(listModels).toHaveBeenCalledOnce();
  });

  it('does not send a completion when an expired catalog cannot be read', async () => {
    const id = await settledSession();
    cachedModels = null;
    listModels.mockResolvedValue({ models: [], error: 'Could not load the model list.' });
    expect(await service.suggestNextPrompt(id, LOCAL_MODEL)).toBeNull();
    expect(indexOf(SUGGESTION_INSTRUCTION)).toBe(-1);
  });

  it.each([
    [LOCAL_MODEL, 30_000],
    [SUGGESTION_MODELS[0], 5_000],
  ])('bounds %s at %i ms and drops any partial answer', async (model, deadline) => {
    const id = await settledSession();
    const schedule = vi.spyOn(globalThis, 'setTimeout');
    const pending = service.suggestNextPrompt(id, model);
    await vi.waitUntil(() => indexOf(SUGGESTION_INSTRUCTION) >= 0);
    const index = indexOf(SUGGESTION_INSTRUCTION);
    streams[index].write(frame({ type: 'content', text: 'Add tests' }));
    const signal = (post.mock.calls[index][2] as { signal: AbortSignal }).signal;

    expect(signal.aborted).toBe(false);
    const expire = schedule.mock.calls.find(([, delay]) => delay === deadline)?.[0];
    expect(expire).toBeTypeOf('function');
    if (typeof expire !== 'function') throw new Error('Suggestion deadline was not scheduled');
    expire();
    expect(signal.aborted).toBe(true);
    expect(await pending).toBeNull();
  });
});
