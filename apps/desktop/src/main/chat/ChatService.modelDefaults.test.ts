import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { ChatModels } from '@bike4mind/common';
import type { ChatModelOption } from '@shared/chat';
import type { ModelSettings } from '@shared/modelSettings';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { COMPACT_MAX_TOKENS } from './compaction';
import type { ModelCatalog } from './ModelCatalog';
import { ollamaControls } from './modelControls';
import { SUGGESTION_MAX_TOKENS } from './nextPrompt';
import { forgetLocalContexts, OllamaLocal } from './OllamaLocal';
import { SessionStore } from './SessionStore';
import { TITLE_INSTRUCTION, TITLE_MAX_TOKENS } from './sessionTitle';
import type { AccessStore } from './tools/AccessStore';

/** Per-request precedence on a device-side model: chat override, model default, catalog sampling, nothing. */

const services: ChatService[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  vi.unstubAllGlobals();
  forgetLocalContexts();
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

interface OllamaBody {
  messages: { role: string; content: string }[];
  think?: boolean | string;
  options: Record<string, unknown>;
}

const MODEL = 'local:ollama:qwen3.8:27b';
const QWEN_THINKING = { temperature: 1, topP: 0.95, topK: 20, minP: 0, presencePenalty: 1.5, repeatPenalty: 1 };
const WIRE_THINKING = { temperature: 1, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 1.5, repeat_penalty: 1 };

function option(extra: Partial<ChatModelOption> = {}): ChatModelOption {
  return {
    id: MODEL,
    name: 'qwen3.8:27b',
    supportsTools: false,
    contextWindow: 8192,
    thinkingToggle: true,
    controls: ollamaControls({ inspected: true, contextWindow: 8192, thinks: true }),
    catalogSampling: { thinking: QWEN_THINKING },
    ...extra,
  };
}

async function setup(
  listed: ChatModelOption,
  defaults?: (modelId: string) => Promise<ModelSettings>,
  show: object = {},
  catalog: object = {}
) {
  const bodies: OllamaBody[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith('/api/tags')) return Response.json({ models: [{ name: 'qwen3.8:27b' }] });
      if (String(input).endsWith('/api/show'))
        return Response.json({
          capabilities: ['completion'],
          model_info: { 'qwen3.context_length': 8192 },
          ...show,
        });
      bodies.push(JSON.parse(String(init?.body)) as OllamaBody);
      return new Response(
        `${JSON.stringify({ message: { content: 'Widget sizing notes' }, done: true, prompt_eval_count: 40, eval_count: 4 })}\n`
      );
    })
  );
  const directory = await mkdtemp(join(tmpdir(), 'b4m-model-defaults-'));
  roots.push(directory);
  const service = new ChatService({
    store: new SessionStore(directory, MODEL),
    access: { list: async () => [] } as unknown as AccessStore,
    models: {
      cached: () => [listed],
      listLocal: async () => [listed],
      list: async () => ({ models: [listed] }),
      ...catalog,
    } as unknown as ModelCatalog,
    ...(defaults ? { modelSettings: { get: defaults } } : {}),
    local: new OllamaLocal(),
    getEnvironmentUrl: () => 'http://localhost:3000',
    logger: { debug: vi.fn(), warn: vi.fn() },
    emit: () => {},
    getApiClient: () => null,
  } as ConstructorParameters<typeof ChatService>[0]);
  services.push(service);
  const isTitle = (body: OllamaBody) => body.messages[0]?.content === TITLE_INSTRUCTION;
  const send = async (id: string, text = 'how big is a widget?') => {
    const before = bodies.length;
    await service.send(id, text);
    await vi.waitUntil(() => !service.isSessionBusy(id) && bodies.length > before, { timeout: 3000, interval: 5 });
  };
  const turn = () => bodies.findLast(body => !isTitle(body));
  const title = async () => {
    await vi.waitUntil(() => bodies.some(isTitle), { timeout: 3000, interval: 5 });
    return bodies.find(isTitle);
  };
  return { service, bodies, send, turn, title };
}

describe('per-model defaults and catalog sampling on a local turn', () => {
  it('sends the catalog thinking sampling of a reviewed build when nothing else is set', async () => {
    const { service, send, turn, title } = await setup(option());
    const { id } = await service.createSession();
    await send(id);
    expect(turn()?.options).toMatchObject(WIRE_THINKING);
    // Titles run with thinking off, and this family states no non-thinking sampling.
    expect((await title())?.options).toEqual({ num_ctx: expect.any(Number), num_predict: TITLE_MAX_TOKENS });
  });

  it('sends the non-thinking sampling while thinking is off, and none when the family has none', async () => {
    const gemma = option({
      catalogSampling: { thinking: { temperature: 1, topK: 64 }, nonThinking: { temperature: 0.7, topK: 40 } },
    });
    const { service, send, turn } = await setup(gemma);
    const { id } = await service.createSession();
    await service.renameSession(id, 'Named');
    await service.setSessionReasoningEffort(id, 'none');
    await send(id);
    expect(turn()?.options).toMatchObject({ temperature: 0.7, top_k: 40 });

    const { service: qwenService, send: sendQwen, turn: qwenTurn } = await setup(option());
    const { id: qwenId } = await qwenService.createSession();
    await qwenService.renameSession(qwenId, 'Named');
    await qwenService.setSessionReasoningEffort(qwenId, 'none');
    await sendQwen(qwenId);
    expect(qwenTurn()?.options).toEqual({ num_ctx: expect.any(Number) });
  });

  it('puts the model default over the catalog and the chat override over both, on the turn only', async () => {
    const defaults = { generation: { temperature: 0.6, maxOutputTokens: 2048 } };
    const { service, bodies, send, turn, title } = await setup(option(), async () => defaults);
    const { id } = await service.createSession();
    await send(id);
    expect(turn()?.options).toMatchObject({ ...WIRE_THINKING, temperature: 0.6, num_predict: 2048 });
    expect((await title())?.options).toEqual({
      num_ctx: expect.any(Number),
      num_predict: TITLE_MAX_TOKENS,
      temperature: 0.6,
    });

    await service.setSessionGeneration(id, { temperature: 0.2, topK: 12 });
    await send(id, 'and a gadget?');
    expect(turn()?.options).toMatchObject({ temperature: 0.2, top_k: 12, top_p: 0.95, num_predict: 2048 });

    expect(await service.suggestNextPrompt(id)).not.toBeNull();
    expect(bodies.at(-1)?.options).toEqual({
      num_ctx: expect.any(Number),
      num_predict: SUGGESTION_MAX_TOKENS,
      temperature: 0.6,
    });
    expect(await service.compactContext(id, '')).toMatchObject({ ok: true });
    expect(bodies.at(-1)?.options).toEqual({
      num_ctx: expect.any(Number),
      num_predict: COMPACT_MAX_TOKENS,
      temperature: 0.6,
    });
  });

  it("sends the model's thinking level while the chat is at Default, and the chat's own level over it", async () => {
    const show = { capabilities: ['completion', 'thinking'], thinking: { values: ['low', 'medium', 'high'] } };
    const levelled = option({
      catalogSampling: undefined,
      controls: { ...option().controls, effort: { levels: ['low', 'medium', 'high'], scope: 'request' } },
    });
    const { service, send, turn } = await setup(levelled, async () => ({ effort: 'high' }), show);
    const { id } = await service.createSession();
    await service.renameSession(id, 'Named');
    await send(id);
    expect(turn()?.think).toBe('high');
    await service.setSessionReasoningEffort(id, 'low');
    await send(id, 'again');
    expect(turn()?.think).toBe('low');
  });

  it('goes on with the catalog sampling when the defaults cannot be read', async () => {
    const { service, send, turn } = await setup(option(), () => Promise.reject(new Error('EACCES')));
    const { id } = await service.createSession();
    await service.renameSession(id, 'Named');
    await send(id);
    expect(turn()?.options).toMatchObject(WIRE_THINKING);
  });

  it('looks defaults up by the listed id when the chat is saved on an alias of it', async () => {
    const alias = 'local:openai-compatible:qwen3.8-27b';
    const lookups: string[] = [];
    const defaults = async (modelId: string) => {
      lookups.push(modelId);
      return modelId === MODEL ? { generation: { temperature: 0.6 } } : {};
    };
    const { service, send, turn, title } = await setup(option({ aliasIds: [alias] }), defaults);
    const { id } = await service.createSession();
    await service.setSessionModel(id, alias);
    await send(id);
    expect(turn()?.options).toMatchObject({ ...WIRE_THINKING, temperature: 0.6 });
    expect((await title())?.options).toMatchObject({ temperature: 0.6 });
    expect(lookups).not.toContain(alias);
  });

  it('seeds from the thinking sampling when only the last known toggle says the model thinks', async () => {
    const listed = option({
      thinkingToggle: undefined,
      catalogSampling: { thinking: { temperature: 1 }, nonThinking: { temperature: 0.7 } },
    });
    const { service, send, turn } = await setup(
      listed,
      async () => ({}),
      {},
      {
        listLocal: undefined,
        list: async () => ({ models: [listed], error: 'The model list could not be loaded.' }),
        lastKnownThinkingToggle: () => true,
      }
    );
    const { id } = await service.createSession();
    await service.renameSession(id, 'Named');
    await send(id);
    expect(turn()?.options).toMatchObject({ temperature: 1 });
  });

  it('sends a hosted model none of the device-side defaults', async () => {
    const model = ChatModels.GEMINI_2_5_FLASH_LITE;
    const hostedOption: ChatModelOption = {
      id: model,
      name: 'Flash Lite',
      backend: 'gemini',
      controls: { temperature: { min: 0, max: 2, step: 0.05, scope: 'request' } },
    };
    const bodies: { options: Record<string, unknown> }[] = [];
    const post = vi.fn().mockImplementation((_url: string, body: { options: Record<string, unknown> }) => {
      bodies.push(body);
      const stream = new PassThrough();
      stream.end(`data: ${JSON.stringify({ type: 'content', text: 'ok' })}\n\ndata: [DONE]\n\n`);
      return Promise.resolve({ data: stream, status: 200 });
    });
    const directory = await mkdtemp(join(tmpdir(), 'b4m-model-defaults-'));
    roots.push(directory);
    const get = vi.fn(async () => ({ generation: { temperature: 0.9 } }));
    const service = new ChatService({
      store: new SessionStore(directory, model),
      access: { list: async () => [] } as unknown as AccessStore,
      models: {
        cached: () => [hostedOption],
        listLocal: async () => [],
        list: async () => ({ models: [hostedOption] }),
        lastKnownThinkingToggle: () => undefined,
      } as unknown as ModelCatalog,
      modelSettings: { get },
      getEnvironmentUrl: () => 'http://localhost:3000',
      logger: { debug: vi.fn(), warn: vi.fn() },
      emit: () => {},
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
    } as ConstructorParameters<typeof ChatService>[0]);
    services.push(service);
    const { id } = await service.createSession();
    await service.renameSession(id, 'Named');
    await service.send(id, 'hello');
    await vi.waitUntil(() => !service.isSessionBusy(id) && bodies.length > 0, { timeout: 3000, interval: 5 });
    expect(get).not.toHaveBeenCalled();
    expect(bodies[0]?.options).not.toHaveProperty('temperature');
  });

  it('sends nothing extra for a model with no defaults and no catalog entry', async () => {
    const { service, send, turn } = await setup(option({ catalogSampling: undefined }), async () => ({}));
    const { id } = await service.createSession();
    await service.renameSession(id, 'Named');
    await send(id);
    expect(turn()?.options).toEqual({ num_ctx: expect.any(Number) });
  });
});
