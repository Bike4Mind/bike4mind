import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatModelOption, ChatSessionSummary, ChatStreamEvent, ReasoningEffortSetting } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { ModelCatalog } from './ModelCatalog';
import type { ModelMemory } from './ModelPreference';
import { deriveTitle, SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { TITLE_INSTRUCTION, TITLE_MAX_TOKENS, TITLE_MODELS } from './sessionTitle';
import type { ModelLoadSettings, ModelSettings } from '@shared/modelSettings';
import { ollamaControls } from './modelControls';
import { forgetLocalContexts, OllamaLocal } from './OllamaLocal';
import { ChatModels, type VideoModel } from '@bike4mind/common';
import { COMPACT_MAX_TOKENS } from './compaction';
import { SUGGESTION_INSTRUCTION, SUGGESTION_MAX_TOKENS, SUGGESTION_MODELS } from './nextPrompt';
import { publicVideoModel } from './media/__fixtures__/videoModels';
import type { MediaStore } from './media/MediaStore';

vi.mock('../git/hostGitArgs', async importOriginal =>
  (await import('./plainFolderGit.testHelper')).skipGitOutsideRepositories(await importOriginal())
);

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
  let directory: string;

  afterEach(() => rm(directory, { recursive: true, force: true }));

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'b4m-model-'));
    remembered = null;
    memory = {
      read: async () => remembered,
      record: vi.fn<ModelMemory['record']>(async (model: string) => {
        remembered = model;
      }),
    };
    store = new SessionStore(directory, 'preferred-model');
    available = HOSTED;
    const boundPost = vi.fn().mockResolvedValue({ data: new PassThrough(), status: 200 });
    post = boundPost;

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
          getAxiosInstance: () => ({ post: boundPost }),
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

  describe('thinking on a local model', () => {
    const LOCAL_THINKER: ChatModelOption = {
      id: 'qwen3:8b',
      name: 'qwen3:8b',
      backend: 'ollama',
      thinkingToggle: true,
    };

    async function turnOptions(
      model: string,
      effort?: 'default' | 'minimal' | 'none'
    ): Promise<Record<string, unknown>> {
      const { id } = await service.createSession();
      await service.setSessionModel(id, model);
      if (effort) await service.setSessionReasoningEffort(id, effort);
      await service.send(id, 'hello');
      const turn = await vi.waitUntil(() => turnRequest(post), { timeout: 2000, interval: 5 });
      return (turn as { options: Record<string, unknown> }).options;
    }

    it('leaves thinking out when the switch is Off, so the server tells Ollama think:false', async () => {
      available = [LOCAL_THINKER];
      expect(await turnOptions('qwen3:8b', 'none')).not.toHaveProperty('thinking');
    });

    it('still reads the Minimal that Off was stored as before as Off', async () => {
      available = [LOCAL_THINKER];
      expect(await turnOptions('qwen3:8b', 'minimal')).not.toHaveProperty('thinking');
    });

    it('keeps thinking for an older Minimal on a model where that was an ignored effort', async () => {
      available = [{ ...LOCAL_THINKER, minimalThinks: true }];
      expect((await turnOptions('qwen3:8b', 'minimal')).thinking).toEqual({ enabled: true });
    });

    it('still asks for thinking when the switch is On', async () => {
      available = [LOCAL_THINKER];
      expect((await turnOptions('qwen3:8b', 'default')).thinking).toEqual({ enabled: true });
    });

    it('keeps thinking on a hosted model whatever the effort', async () => {
      expect((await turnOptions('gpt-4o', 'minimal')).thinking).toEqual({ enabled: true });
    });
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

describe('thinkingCatalog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('thinking preference after a catalog refresh failure', () => {
    it.each([
      { switchedEnvironment: false, thinking: false },
      { switchedEnvironment: true, thinking: true },
    ])(
      'preserves Off only for the same environment ($switchedEnvironment)',
      async ({ switchedEnvironment, thinking }) => {
        let environmentUrl = 'http://localhost:3000';
        const getModels = vi.fn().mockResolvedValue({
          models: [{ id: 'qwen3:8b', type: 'text', backend: 'ollama', supportsTools: true, can_think: true }],
        });
        const logger = { debug: vi.fn(), warn: vi.fn() };
        const models = new ModelCatalog(
          {
            logger,
            getEnvironmentUrl: () => environmentUrl,
            getApiClient: () => ({ get: getModels }) as unknown as AuthenticatedApiClient,
          },
          { models: async () => [] } as never
        );
        const post = vi.fn().mockResolvedValue({ data: new PassThrough(), status: 200 });
        const service = new ChatService({
          store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-thinking-catalog-')), 'qwen3:8b'),
          access: { list: async () => [] } as unknown as AccessStore,
          models,
          preferredModel: 'qwen3:8b',
          logger,
          getApiClient: () =>
            ({
              get: async () => ({ sseCompletionsUrl: '' }),
              getAxiosInstance: () => ({ post }),
            }) as unknown as AuthenticatedApiClient,
          getEnvironmentUrl: () => environmentUrl,
          emit: () => {},
        });
        const { id } = await service.createSession();
        await service.setSessionReasoningEffort(id, 'minimal');
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
        getModels.mockRejectedValue(new Error('temporary catalog failure'));
        if (switchedEnvironment) environmentUrl = 'https://other.example.com';

        await service.send(id, 'hello');
        const request = await vi.waitUntil(
          () =>
            post.mock.calls
              .map(call => call[1] as { messages: { content: unknown }[]; options: Record<string, unknown> })
              .find(body => body.messages[0]?.content !== TITLE_INSTRUCTION),
          { timeout: 2000, interval: 5 }
        );
        if (thinking) expect(request.options.thinking).toEqual({ enabled: true });
        else expect(request.options).not.toHaveProperty('thinking');
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('model list lookup failed'));
        expect(models.cached()).toBeNull();
      }
    );
  });
});

describe('loadOptions', () => {
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
    keep_alive?: number;
    options: Record<string, unknown>;
  }

  const MODEL = 'local:ollama:qwen3.8:27b';

  const listed: ChatModelOption = {
    id: MODEL,
    name: 'qwen3.8:27b',
    supportsTools: false,
    contextWindow: 32768,
    controls: ollamaControls({ inspected: true, contextWindow: 32768 }),
  };

  async function setup(load: ModelLoadSettings, trained = 262144) {
    const bodies: OllamaBody[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        if (String(input).endsWith('/api/tags')) return Response.json({ models: [{ name: 'qwen3.8:27b' }] });
        if (String(input).endsWith('/api/show'))
          return Response.json({
            capabilities: ['completion'],
            model_info: { 'qwen35.context_length': trained, 'qwen35.nextn_predict_layers': 1 },
          });
        bodies.push(JSON.parse(String(init?.body)) as OllamaBody);
        return new Response(
          `${JSON.stringify({ message: { content: 'Widget sizing notes' }, done: true, prompt_eval_count: 40, eval_count: 4 })}\n`
        );
      })
    );
    const renamed = vi.fn();
    const directory = await mkdtemp(join(tmpdir(), 'b4m-load-options-'));
    roots.push(directory);
    const loadSettings = vi.fn(async (modelId: string) => (modelId === MODEL ? load : {}));
    const service = new ChatService({
      store: new SessionStore(directory, MODEL),
      access: { list: async () => [] } as unknown as AccessStore,
      models: {
        cached: () => [listed],
        listLocal: async () => [listed],
        list: async () => ({ models: [listed] }),
      } as unknown as ModelCatalog,
      local: new OllamaLocal(undefined, undefined, undefined, loadSettings),
      getEnvironmentUrl: () => 'http://localhost:3000',
      logger: { debug: vi.fn(), warn: vi.fn() },
      emit: () => {},
      summaryChanged: renamed,
      getApiClient: () => null,
    } as ConstructorParameters<typeof ChatService>[0]);
    services.push(service);
    // The title is named by a floating promise; teardown must wait for its session write.
    const settled = (id: string) =>
      vi.waitUntil(
        () =>
          !service.isSessionBusy(id) &&
          renamed.mock.calls.some(([summary]) => (summary as { title?: string }).title === 'Widget sizing notes'),
        { timeout: 3000, interval: 5 }
      );
    return { service, bodies, settled };
  }

  describe("a local model's load settings", () => {
    it('ride the turn, the title, the suggestion and the summary alike', async () => {
      const { service, bodies, settled } = await setup({
        context: { mode: 'fixed', tokens: 32768 },
        draftTokens: 3,
        keepAlive: 3600,
      });
      const { id } = await service.createSession();
      await service.send(id, 'how big is a widget?');
      await settled(id);
      expect(await service.suggestNextPrompt(id)).not.toBeNull();
      expect(await service.compactContext(id, '')).toMatchObject({ ok: true });

      expect(bodies.length).toBeGreaterThanOrEqual(4);
      for (const body of bodies) {
        expect(body.keep_alive).toBe(3600);
        expect(body.options).toMatchObject({ num_ctx: 32768, draft_num_predict: 3 });
      }
    });

    it('send the trained length a model stores as its context', async () => {
      const { service, bodies, settled } = await setup({ context: { mode: 'fixed', tokens: 40960 } }, 40960);
      const { id } = await service.createSession();
      await service.send(id, 'how big is a widget?');
      await settled(id);
      expect(bodies[0].options.num_ctx).toBe(40960);
    });

    it('send nothing extra for a model with none set', async () => {
      const { service, bodies, settled } = await setup({});
      const { id } = await service.createSession();
      await service.send(id, 'how big is a widget?');
      await settled(id);
      for (const body of bodies) {
        expect(body).not.toHaveProperty('keep_alive');
        expect(body.options).not.toHaveProperty('draft_num_predict');
        expect(body.options.num_ctx).toBe(16384);
      }
    });
  });
});

describe('generation', () => {
  /** A conversation's overrides reach its own turns, and never a title, a suggestion or a compaction. */

  const services: ChatService[] = [];
  const roots: string[] = [];
  afterEach(async () => {
    for (const service of services.splice(0)) service.dispose();
    vi.unstubAllGlobals();
    forgetLocalContexts();
    await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  async function storeFor(prefix: string, model: string): Promise<SessionStore> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    roots.push(directory);
    return new SessionStore(directory, model);
  }

  function frame(payload: unknown): string {
    return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
  }

  const OVERRIDES = { temperature: 0.3, topK: 12, maxOutputTokens: 2048, thinkingBudgetTokens: 4096 };

  function serviceFor(option: ChatModelOption, deps: Partial<ConstructorParameters<typeof ChatService>[0]>) {
    const service = new ChatService({
      access: { list: async () => [] } as unknown as AccessStore,
      models: {
        cached: () => [option],
        listLocal: async () => [option],
        list: async () => ({ models: [option] }),
      } as unknown as ModelCatalog,
      getEnvironmentUrl: () => 'http://localhost:3000',
      logger: { debug: vi.fn(), warn: vi.fn() },
      emit: () => {},
      getApiClient: () => null,
      ...deps,
    } as ConstructorParameters<typeof ChatService>[0]);
    services.push(service);
    return service;
  }

  describe('per-conversation generation settings on a hosted model', () => {
    const model = ChatModels.GEMINI_2_5_FLASH_LITE;
    const option: ChatModelOption = {
      id: model,
      name: 'Flash Lite',
      backend: 'gemini',
      maxOutputTokens: 8192,
      controls: {
        temperature: { min: 0, max: 2, step: 0.05, scope: 'request' },
        maxOutputTokens: { min: 1024, max: 8192, step: 256, default: 8192, scope: 'request' },
      },
    };

    interface Body {
      messages: { role: string; content: unknown }[];
      max_tokens?: number;
      options: Record<string, unknown>;
    }

    async function hosted() {
      const bodies: Body[] = [];
      const post = vi.fn().mockImplementation((_url: string, body: Body) => {
        bodies.push(body);
        const stream = new PassThrough();
        stream.end(frame({ type: 'content', text: 'Widget sizing notes' }) + frame('[DONE]'));
        return Promise.resolve({ data: stream, status: 200 });
      });
      const store = await storeFor('b4m-generation-', model);
      const service = serviceFor(option, {
        store,
        getApiClient: () =>
          ({
            get: vi.fn().mockResolvedValue({}),
            getAxiosInstance: () => ({ post }),
          }) as unknown as AuthenticatedApiClient,
      });
      return { service, bodies };
    }

    const isTitle = (body: Body) => body.messages[0]?.content === TITLE_INSTRUCTION;
    const isSuggestion = (body: Body) => body.messages[0]?.content === SUGGESTION_INSTRUCTION;

    it('sends the overrides the model lists on the turn only', async () => {
      const { service, bodies } = await hosted();
      const { id } = await service.createSession();
      await service.setSessionGeneration(id, OVERRIDES);

      await service.send(id, 'how big is a widget?');
      await vi.waitUntil(() => !service.isSessionBusy(id) && bodies.some(isTitle), { timeout: 3000, interval: 5 });
      const turn = bodies.find(body => !isTitle(body));
      expect(turn?.max_tokens).toBe(2048);
      expect(turn?.options).toMatchObject({ temperature: 0.3 });
      expect(turn?.options).not.toHaveProperty('thinking.budget_tokens');
      expect(JSON.stringify(turn)).not.toMatch(/top_?[kK]/);

      const title = bodies.find(isTitle);
      expect(title?.max_tokens).toBe(TITLE_MAX_TOKENS);
      expect(title?.options).not.toHaveProperty('temperature');

      expect(await service.suggestNextPrompt(id, model)).not.toBeNull();
      const suggestion = bodies.find(isSuggestion);
      expect(suggestion?.max_tokens).toBe(SUGGESTION_MAX_TOKENS);
      expect(suggestion?.options).not.toHaveProperty('temperature');

      expect(await service.compactContext(id, '')).toMatchObject({ ok: true });
      const compaction = bodies.at(-1);
      expect(compaction?.max_tokens).toBe(COMPACT_MAX_TOKENS);
      expect(compaction?.options).not.toHaveProperty('temperature');
    });

    it('sends no override while the model list cannot be read, since no controls say what the model takes', async () => {
      const bodies: Body[] = [];
      const post = vi.fn().mockImplementation((_url: string, body: Body) => {
        bodies.push(body);
        const stream = new PassThrough();
        stream.end(frame({ type: 'content', text: 'ok' }) + frame('[DONE]'));
        return Promise.resolve({ data: stream, status: 200 });
      });
      const service = serviceFor(option, {
        store: await storeFor('b4m-generation-offline-', model),
        models: {
          cached: () => null,
          listLocal: async () => [],
          list: async () => ({ models: [], error: 'The model list could not be loaded.' }),
          lastKnownThinkingToggle: () => undefined,
        } as unknown as ModelCatalog,
        getApiClient: () =>
          ({
            get: vi.fn().mockResolvedValue({}),
            getAxiosInstance: () => ({ post }),
          }) as unknown as AuthenticatedApiClient,
      });
      const { id } = await service.createSession();
      await service.renameSession(id, 'Named');
      await service.setSessionGeneration(id, OVERRIDES);
      await service.send(id, 'hello');
      await vi.waitUntil(() => !service.isSessionBusy(id), { timeout: 3000, interval: 5 });
      expect(bodies[0]?.options).not.toHaveProperty('temperature');
      expect(bodies[0]?.options).not.toHaveProperty('thinking.budget_tokens');
      expect(bodies[0]).not.toHaveProperty('max_tokens');
    });

    it('sends nothing extra for an untouched conversation', async () => {
      const { service, bodies } = await hosted();
      const { id } = await service.createSession();
      await service.renameSession(id, 'Named');
      await service.send(id, 'hello');
      await vi.waitUntil(() => !service.isSessionBusy(id), { timeout: 3000, interval: 5 });
      expect(bodies[0]?.max_tokens).toBe(8192);
      expect(bodies[0]?.options).not.toHaveProperty('temperature');
    });
  });

  describe('reasoning effort through a hosted model controls', () => {
    interface Body {
      messages: { role: string; content: unknown }[];
      options: { reasoningEffort?: string; thinking?: { enabled: boolean } };
    }

    async function turnWith(levels: ReasoningEffortSetting[], setting: ReasoningEffortSetting): Promise<Body> {
      const option: ChatModelOption = {
        id: ChatModels.GPT5,
        name: 'GPT-5',
        backend: 'openai',
        supportsReasoningEffort: true,
        controls: { effort: { levels, scope: 'request' } },
      };
      const bodies: Body[] = [];
      const post = vi.fn().mockImplementation((_url: string, body: Body) => {
        bodies.push(body);
        const stream = new PassThrough();
        stream.end(frame({ type: 'content', text: 'ok' }) + frame('[DONE]'));
        return Promise.resolve({ data: stream, status: 200 });
      });
      const store = await storeFor('b4m-effort-', option.id);
      const service = serviceFor(option, {
        store,
        getApiClient: () =>
          ({
            get: vi.fn().mockResolvedValue({}),
            getAxiosInstance: () => ({ post }),
          }) as unknown as AuthenticatedApiClient,
      });
      const { id } = await service.createSession();
      await service.renameSession(id, 'Named');
      await service.setSessionReasoningEffort(id, setting);
      await service.send(id, 'hello');
      await vi.waitUntil(() => !service.isSessionBusy(id), { timeout: 3000, interval: 5 });
      return bodies[0] as Body;
    }

    it('sends a level only the controls list, with thinking on', async () => {
      const body = await turnWith(['none', 'low', 'high', 'xhigh'], 'xhigh');
      expect(body.options).toMatchObject({ reasoningEffort: 'xhigh', thinking: { enabled: true } });
    });

    it('sends none and asks for no thinking', async () => {
      const body = await turnWith(['none', 'low', 'high', 'xhigh'], 'none');
      expect(body.options.reasoningEffort).toBe('none');
      expect(body.options).not.toHaveProperty('thinking');
    });

    it('sends the nearest listed level for a stored one the model no longer lists', async () => {
      expect((await turnWith(['low', 'medium', 'high'], 'minimal')).options.reasoningEffort).toBe('low');
    });
  });

  describe('per-conversation generation settings on a local model', () => {
    interface OllamaBody {
      messages: { role: string; content: string }[];
      options: Record<string, unknown>;
    }

    it('reaches the Ollama turn, and never its title, suggestion or compaction', async () => {
      const bodies: OllamaBody[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown, init?: RequestInit) => {
          if (String(input).endsWith('/api/tags')) return Response.json({ models: [{ name: 'llama3.2' }] });
          if (String(input).endsWith('/api/show'))
            return Response.json({ capabilities: ['completion'], model_info: { 'llama.context_length': 8192 } });
          bodies.push(JSON.parse(String(init?.body)) as OllamaBody);
          return new Response(
            `${JSON.stringify({ message: { content: 'Widget sizing notes' }, done: true, prompt_eval_count: 40, eval_count: 4 })}\n`
          );
        })
      );
      const model = 'local:ollama:llama3.2';
      const option: ChatModelOption = {
        id: model,
        name: 'llama3.2',
        supportsTools: false,
        contextWindow: 8192,
        controls: {
          temperature: { min: 0, max: 2, step: 0.05, default: 0.8, scope: 'request' },
          topK: { min: 1, max: 200, step: 1, default: 40, scope: 'request' },
          maxOutputTokens: { min: 256, max: 8192, step: 256, scope: 'request' },
        },
      };
      const store = await storeFor('b4m-generation-local-', model);
      const service = serviceFor(option, { store, local: new OllamaLocal() });
      const { id } = await service.createSession();
      await service.setSessionGeneration(id, OVERRIDES);

      await service.send(id, 'how big is a widget?');
      const isTitle = (body: OllamaBody) => body.messages[0]?.content === TITLE_INSTRUCTION;
      await vi.waitUntil(() => !service.isSessionBusy(id) && bodies.some(isTitle), { timeout: 3000, interval: 5 });
      const turn = bodies.find(body => !isTitle(body));
      expect(turn?.options).toMatchObject({ temperature: 0.3, top_k: 12, num_predict: 2048 });
      expect(bodies.find(isTitle)?.options).toEqual({ num_ctx: expect.any(Number), num_predict: TITLE_MAX_TOKENS });

      expect(await service.suggestNextPrompt(id)).not.toBeNull();
      expect(bodies.at(-1)?.options).toEqual({ num_ctx: expect.any(Number), num_predict: SUGGESTION_MAX_TOKENS });

      expect(await service.compactContext(id, '')).toMatchObject({ ok: true });
      expect(bodies.at(-1)?.options).toEqual({ num_ctx: expect.any(Number), num_predict: COMPACT_MAX_TOKENS });
    });
  });
});

describe('nextPrompt', () => {
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
        async () =>
          (await service.getSession(id))?.messages.at(-1)?.content === 'Done. Want tests next?' &&
          !service.isSessionBusy(id),
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
      await vi.waitUntil(() => indexOf(SUGGESTION_INSTRUCTION) >= 0, { timeout: 5000, interval: 5 });
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
});

describe('promptCache', () => {
  const MODELS: ChatModelOption[] = [
    { id: 'claude-opus-5-5', name: 'Opus 5.5', backend: 'anthropic', supportsOneHourCache: true },
    { id: 'claude-sonnet-4-5', name: 'Sonnet 4.5', backend: 'anthropic' },
    { id: 'gpt-5', name: 'GPT-5', backend: 'openai' },
  ];

  function frame(payload: unknown): string {
    return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
  }

  interface Posted {
    body: { messages: { content: unknown }[]; options?: Record<string, unknown> };
    stream: PassThrough;
  }

  describe('ChatService prompt cache lifetime', () => {
    let posted: Posted[];
    let events: ChatStreamEvent[];
    let service: ChatService;
    let store: SessionStore;

    beforeEach(async () => {
      const opened: Posted[] = (posted = []);
      const emitted: ChatStreamEvent[] = (events = []);
      const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-cache-ttl-')));
      const post = vi.fn().mockImplementation((_url: string, body: Posted['body']) => {
        const stream = new PassThrough();
        opened.push({ body, stream });
        return Promise.resolve({ data: stream, status: 200 });
      });
      store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-cache-ttl-sessions-')), 'claude-opus-5-5');
      service = new ChatService({
        store,
        models: { list: async () => ({ models: MODELS }), cached: () => MODELS } as unknown as ModelCatalog,
        access: { list: async () => [root] } as unknown as AccessStore,
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: () =>
          ({
            get: vi.fn().mockResolvedValue({}),
            getAxiosInstance: () => ({ post }),
          }) as unknown as AuthenticatedApiClient,
        getEnvironmentUrl: () => 'http://localhost:3000',
        emit: event => emitted.push(event),
      });
    });

    /** Runs one turn on `model` at `ttl` and returns the turn's request options and its 'done' event. */
    async function runTurn(model: string, ttl: '5m' | '1h') {
      const { id } = await service.createSession();
      await service.setSessionModel(id, model);
      await service.setSessionPromptCacheTtl(id, ttl);
      const before = Date.now();
      await service.send(id, 'go');
      const turn = await vi.waitUntil(
        () => posted.find(entry => entry.body.messages[0]?.content !== TITLE_INSTRUCTION),
        {
          timeout: 3000,
          interval: 5,
        }
      );
      turn.stream.write(frame({ type: 'content', text: 'hello' }));
      turn.stream.write(frame('[DONE]'));
      const done = await vi.waitUntil(
        () => events.find((event): event is Extract<ChatStreamEvent, { type: 'done' }> => event.type === 'done'),
        { timeout: 3000, interval: 5 }
      );
      const stored = (await service.getSession(id))?.messages.find(message => message.role === 'assistant');
      return { options: turn.body.options ?? {}, done, stored, before };
    }

    it('asks for the hour on a model that takes it and stamps the reply with it', async () => {
      const { options, done, stored, before } = await runTurn('claude-opus-5-5', '1h');

      expect(options).toMatchObject({ cacheTtl: '1h' });
      expect(done.promptCache).toMatchObject({ ttl: '1h', model: 'claude-opus-5-5' });
      expect(done.promptCache!.cachedAt).toBeGreaterThanOrEqual(before);
      expect(stored?.promptCache).toEqual(done.promptCache);
    });

    it('sends no lifetime at 5 minutes, or on a Claude model without the hour, and stamps 5 minutes', async () => {
      const fiveMinutes = await runTurn('claude-opus-5-5', '5m');
      expect(fiveMinutes.options).not.toHaveProperty('cacheTtl');
      expect(fiveMinutes.done.promptCache).toMatchObject({ ttl: '5m' });

      posted.length = 0;
      events.length = 0;
      const older = await runTurn('claude-sonnet-4-5', '1h');
      expect(older.options).not.toHaveProperty('cacheTtl');
      expect(older.done.promptCache).toMatchObject({ ttl: '5m', model: 'claude-sonnet-4-5' });
    });

    it('stores the stamp on a continued reply, not just on its done event', async () => {
      const { id } = await service.createSession();
      await store.appendMessage(id, {
        id: 'resume-me',
        role: 'assistant',
        content: 'Partial',
        createdAt: new Date().toISOString(),
        stopReason: 'tool_turn_limit',
      });
      expect(await service.continueReply(id)).toMatchObject({ ok: true });
      const turn = await vi.waitUntil(
        () => posted.find(entry => entry.body.messages[0]?.content !== TITLE_INSTRUCTION),
        {
          timeout: 3000,
          interval: 5,
        }
      );
      turn.stream.write(frame({ type: 'content', text: 'more' }));
      turn.stream.write(frame('[DONE]'));
      const done = await vi.waitUntil(
        () => events.find((event): event is Extract<ChatStreamEvent, { type: 'done' }> => event.type === 'done'),
        { timeout: 3000, interval: 5 }
      );

      expect(done.promptCache).toMatchObject({ ttl: '5m', model: 'claude-opus-5-5' });
      const stored = (await service.getSession(id))?.messages.find(message => message.id === 'resume-me');
      expect(stored?.promptCache).toEqual(done.promptCache);
    });

    it('stamps nothing on a model Desktop does not cache', async () => {
      const { options, done, stored } = await runTurn('gpt-5', '1h');

      expect(options).not.toHaveProperty('cacheTtl');
      expect(done.promptCache).toBeUndefined();
      expect(stored?.promptCache).toBeUndefined();
    });
  });
});

describe('creationTools', () => {
  const HOSTED = 'claude-opus-4-5-20251101';
  const NO_TOOLS = 'plain-text-model';
  const LOCAL = 'local:ollama:qwen3:8b';
  const LOCAL_NO_TOOLS = 'local:ollama:plain';

  const CATALOG: ChatModelOption[] = [
    { id: HOSTED, name: 'Claude 4.5 Opus', backend: 'anthropic' },
    { id: NO_TOOLS, name: 'Plain', backend: 'openai', supportsTools: false },
    { id: LOCAL, name: 'Local', backend: 'local-ollama', supportsTools: true },
    { id: LOCAL_NO_TOOLS, name: 'Local plain', backend: 'local-ollama', supportsTools: false },
  ];

  /** The blank chat's cards must match what runTurn would declare; see toolsForRequest. */
  describe('ChatService.listCreationTools', () => {
    let signedIn: boolean;
    let video: VideoModel[];
    let listVideoModels: ReturnType<typeof vi.fn>;

    async function service(media = true): Promise<ChatService> {
      return new ChatService({
        store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-creation-tools-')), HOSTED),
        access: { list: async () => [] } as unknown as AccessStore,
        models: {
          list: async () => ({ models: CATALOG }),
          listLocal: async () => CATALOG.filter(model => model.id.startsWith('local:')),
          cached: () => CATALOG,
          listVideoModels,
        } as unknown as ModelCatalog,
        ...(media ? { media: {} as MediaStore } : {}),
        preferredModel: HOSTED,
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: () => (signedIn ? ({} as AuthenticatedApiClient) : null),
        getEnvironmentUrl: () => 'http://localhost:3000',
        emit: () => {},
        summaryChanged: () => {},
      });
    }

    const names = async (chat: ChatService, model: string) =>
      (await chat.listCreationTools(model)).map(tool => tool.name);

    beforeEach(() => {
      signedIn = true;
      video = [publicVideoModel('gemini-omni-1.1-flash')];
      listVideoModels = vi.fn(async () => video);
    });

    it('offers every generation tool to a hosted model when the server has video', async () => {
      expect(await names(await service(), HOSTED)).toEqual([
        'generate_image',
        'generate_speech',
        'generate_sound_effect',
        'generate_music',
        'generate_video',
      ]);
    });

    it('drops video when the server offers no video model', async () => {
      video = [];
      expect(await names(await service(), HOSTED)).not.toContain('generate_video');
    });

    it('offers the same generation tools to a tool-capable local model', async () => {
      const chat = await service();
      expect(await names(chat, LOCAL)).toEqual(await names(chat, HOSTED));
    });

    it('offers nothing to an unknown local model', async () => {
      expect(await names(await service(), 'local:ollama:missing')).toEqual([]);
    });

    it.each([NO_TOOLS, LOCAL_NO_TOOLS])('offers nothing to a model that takes no tools: %s', async model => {
      expect(await names(await service(), model)).toEqual([]);
    });

    it.each([HOSTED, LOCAL])('offers nothing signed out or without a media store: %s', async model => {
      expect(await names(await service(false), model)).toEqual([]);
      signedIn = false;
      expect(await names(await service(), model)).toEqual([]);
    });
  });
});

describe('modelDefaults', () => {
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

    it('fails the turn with the read error, in its own conversation, when the defaults cannot be read', async () => {
      const unreadable = 'The model settings file /data/model-settings.json is not valid JSON.';
      const { service, bodies } = await setup(option(), () => Promise.reject(new Error(unreadable)));
      const { id } = await service.createSession();
      const { id: other } = await service.createSession();
      await service.renameSession(id, 'Named');
      await service.send(id, 'how big is a widget?');
      await vi.waitUntil(async () => (await service.getSession(id))?.messages.at(-1)?.error !== undefined, {
        timeout: 3000,
        interval: 5,
      });
      expect((await service.getSession(id))?.messages.at(-1)?.error).toContain(unreadable);
      expect((await service.getSession(other))?.messages ?? []).toEqual([]);
      expect(bodies).toEqual([]);
    });

    it('looks defaults up by the listed id when the chat is saved on an alias of it', async () => {
      const alias = 'local:ollama:qwen3.8:27b-alias';
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
        controls: {
          temperature: { min: 0, max: 2, step: 0.05, scope: 'request' },
          effort: { levels: ['low', 'high'], scope: 'request' },
        },
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
      await service.setSessionGeneration(id, { temperature: 0.3 });
      await service.setSessionReasoningEffort(id, 'high');
      await service.send(id, 'hello');
      await vi.waitUntil(() => !service.isSessionBusy(id) && bodies.length > 0, { timeout: 3000, interval: 5 });
      expect(get).not.toHaveBeenCalled();
      const { tools, ...options } = bodies[0]?.options ?? {};
      expect(tools).toBeDefined();
      expect(options).toEqual({
        stream: true,
        thinking: { enabled: true },
        reasoningEffort: 'high',
        temperature: 0.3,
      });
    });

    it('sends nothing extra for a model with no defaults and no catalog entry', async () => {
      const { service, send, turn } = await setup(option({ catalogSampling: undefined }), async () => ({}));
      const { id } = await service.createSession();
      await service.renameSession(id, 'Named');
      await send(id);
      expect(turn()?.options).toEqual({ num_ctx: expect.any(Number) });
    });
  });
});

describe('title', () => {
  const SESSION_MODEL = 'claude-opus-4-5-20251101';
  const TITLE_MODEL = TITLE_MODELS[0];

  const CATALOG: ChatModelOption[] = [
    { id: SESSION_MODEL, name: 'Claude 4.5 Opus' },
    { id: TITLE_MODEL, name: 'Claude 4.5 Haiku' },
  ];

  function frame(payload: unknown): string {
    return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
  }

  /** What the title request looks like on the wire: the small model, and no transcript. */
  type WireRequest = {
    model: string;
    max_tokens?: number;
    messages: { role: string; content: unknown }[];
    options: { tools: unknown[] };
  };

  describe('ChatService session titles', () => {
    let store: SessionStore;
    let service: ChatService;
    let available: ChatModelOption[];
    let summaries: ChatSessionSummary[];
    /** One stream per request, so the reply and the title are answered independently. */
    let streams: PassThrough[];
    let post: ReturnType<typeof vi.fn>;
    let applied: ReturnType<typeof vi.fn<(summary: ChatSessionSummary | null) => void>>;

    const titleCall = (): [string, WireRequest] | undefined =>
      post.mock.calls.find(call => (call[1] as WireRequest).model === TITLE_MODEL) as [string, WireRequest] | undefined;

    /** The turn's own request. The two are concurrent by design, so neither is reliably first. */
    const replyIndex = (): number =>
      post.mock.calls.findIndex(call => (call[1] as WireRequest).messages[0]?.content !== TITLE_INSTRUCTION);

    /** The stream the title request was handed, once it has gone out. */
    async function titleStream(): Promise<PassThrough> {
      await vi.waitUntil(() => titleCall() !== undefined, { timeout: 5000, interval: 5 });
      return streams[post.mock.calls.findIndex(call => (call[1] as WireRequest).model === TITLE_MODEL)];
    }

    // The reply goes out after more setup than the title does, so under load it is often second.
    async function replyStream(): Promise<PassThrough> {
      await vi.waitUntil(() => replyIndex() >= 0, { timeout: 5000, interval: 5 });
      return streams[replyIndex()];
    }

    beforeEach(async () => {
      store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-title-')), SESSION_MODEL);
      // The end of the title path, spied on so a test can wait for it rather than for a timeout:
      // most of what these cases assert is that NOTHING changed, which no push announces.
      const applyGeneratedTitle = store.applyGeneratedTitle.bind(store);
      applied = vi.fn<(summary: ChatSessionSummary | null) => void>();
      vi.spyOn(store, 'applyGeneratedTitle').mockImplementation(async (id, title) => {
        const result = await applyGeneratedTitle(id, title);
        applied(result);
        return result;
      });
      available = CATALOG;
      // The service closes over these consts, not the reassigned lets: an earlier test's reply
      // that only reaches the wire after its test ended would otherwise land in this test's mocks.
      const ownSummaries: ChatSessionSummary[] = (summaries = []);
      const ownStreams: PassThrough[] = (streams = []);
      const ownPost = (post = vi.fn().mockImplementation(() => {
        const stream = new PassThrough();
        ownStreams.push(stream);
        return Promise.resolve({ data: stream, status: 200 });
      }));

      service = new ChatService({
        store,
        access: { list: async () => [] } as unknown as AccessStore,
        models: { list: async () => ({ models: available }), cached: () => available } as unknown as ModelCatalog,
        preferredModel: SESSION_MODEL,
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: () =>
          ({
            get: async () => ({ sseCompletionsUrl: '' }),
            getAxiosInstance: () => ({ post: ownPost }),
          }) as unknown as AuthenticatedApiClient,
        getEnvironmentUrl: () => 'http://localhost:3000',
        emit: () => {},
        summaryChanged: summary => ownSummaries.push(summary),
      });
    });

    async function answerTitle(text: string): Promise<void> {
      const stream = await titleStream();
      stream.write(frame({ type: 'content', text }));
      stream.write(frame('[DONE]'));
    }

    it('names the session from its first prompt, and tells the sidebar', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'In my shared folder, read alpha.txt and tell me what it says');

      await answerTitle('Reading alpha.txt');

      await vi.waitUntil(() => summaries.length > 0, { timeout: 5000, interval: 5 });
      expect(summaries[0]).toMatchObject({ id, title: 'Reading alpha.txt' });
      expect((await service.getSession(id))?.title).toBe('Reading alpha.txt');
    });

    // The property that matters: a reply runs to completion while the title request is still
    // unanswered. Nothing about the turn waits on naming the row.
    it('does not hold up the reply', async () => {
      const { id } = await service.createSession();
      expect(await service.send(id, 'explain event loops')).toMatchObject({ ok: true });

      const title = await titleStream();
      const reply = await replyStream();
      reply.write(frame({ type: 'content', text: 'An event loop', stopReason: 'end_turn' }));
      reply.write(frame('[DONE]'));

      await vi.waitUntil(async () => (await service.getSession(id))?.messages[1]?.content === 'An event loop', {
        timeout: 5000,
        interval: 5,
      });
      expect(title.writableEnded).toBe(false);
      expect((await service.getSession(id))?.title).toBe('explain event loops');
    });

    it('sends the prompt alone on the cheap model - no transcript, no tools', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'explain event loops');

      const request = (await vi.waitUntil(titleCall, { timeout: 5000, interval: 5 }))[1];

      expect(request.model).toBe(TITLE_MODEL);
      expect(request.options.tools).toEqual([]);
      expect(request.messages.map(message => message.role)).toEqual(['system', 'user']);
      expect(request.messages[1].content).toContain('explain event loops');
    });

    it('caps the reply, so a model that answers instead of naming cannot run away', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'explain event loops');

      const request = (await vi.waitUntil(titleCall, { timeout: 5000, interval: 5 }))[1];

      expect(request.max_tokens).toBe(TITLE_MAX_TOKENS);
    });

    it('titles a session only once, not on every turn', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'first');
      await answerTitle('The first thing');
      await vi.waitUntil(() => summaries.length > 0, { timeout: 5000, interval: 5 });

      const reply = await replyStream();
      reply.write(frame({ type: 'content', text: 'ok' }));
      reply.write(frame('[DONE]'));
      // The turn's end, not its text: the content lands a frame before [DONE] closes the turn, and
      // a send in between is refused as "still replying", so no second request ever goes out.
      await vi.waitUntil(() => !service.isSessionBusy(id), { timeout: 5000, interval: 5 });
      expect((await service.getSession(id))?.messages[1]?.content).toBe('ok');

      const before = post.mock.calls.length;
      expect(await service.send(id, 'second')).toMatchObject({ ok: true });
      await vi.waitUntil(() => post.mock.calls.length > before, { timeout: 5000, interval: 5 });

      expect(post.mock.calls.slice(before).some(call => (call[1] as WireRequest).model === TITLE_MODEL)).toBe(false);
    });

    // The two paths that break quietly: generation fails, and the user renames mid-flight.
    it('keeps the truncated title when the title request fails', async () => {
      const prompt = 'Run the shell command echo hello-from-a-very-long-prompt please';
      const { id } = await service.createSession();
      await service.send(id, prompt);

      const stream = await titleStream();
      stream.destroy(new Error('socket hung up'));

      // Nothing reaches the sidebar and nothing reaches the conversation: a title that could not
      // be generated is cosmetic.
      await vi.waitUntil(() => stream.destroyed, { timeout: 5000, interval: 5 });
      expect(summaries).toEqual([]);
      expect((await service.getSession(id))?.title).toBe(deriveTitle(prompt));
    });

    it('keeps the truncated title when the model answers instead of naming', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'what is a monad');

      const stream = await titleStream();
      await answerTitle(
        `I'd be happy to explain. ${'A monad is a monoid in the category of endofunctors. '.repeat(3)}`
      );

      // Rejected before the store is even asked: an answer is not a title.
      await vi.waitUntil(() => stream.destroyed, { timeout: 5000, interval: 5 });
      expect(applied).not.toHaveBeenCalled();
      expect(summaries).toEqual([]);
      expect((await service.getSession(id))?.title).toBe('what is a monad');
    });

    it('lets a rename made while the request was in flight win', async () => {
      const { id } = await service.createSession();
      await service.send(id, 'what is a monad');
      await vi.waitUntil(() => titleCall() !== undefined, { timeout: 5000, interval: 5 });

      await service.renameSession(id, 'Category theory reading');
      await answerTitle('Understanding monads');

      // The store was asked and refused, which is the guard working rather than the request
      // simply never arriving.
      await vi.waitUntil(() => applied.mock.calls.length > 0, { timeout: 5000, interval: 5 });
      expect(applied).toHaveBeenCalledWith(null);
      expect(summaries).toEqual([]);
      expect((await service.getSession(id))?.title).toBe('Category theory reading');
    });

    // An unreadable catalog is not evidence about what the server offers, and the session's own
    // model could be the most expensive thing on it.
    it('does not generate a title when the catalog is unreadable', async () => {
      available = [];
      const { id } = await service.createSession();
      await service.send(id, 'what is a monad');

      await new Promise(resolve => setTimeout(resolve, 20));
      expect(titleCall()).toBeUndefined();
      expect((await service.getSession(id))?.title).toBe('what is a monad');
    });

    // A session the agent named at spawn time never pays for a title it would not be allowed to use.
    it('does not generate a title for a session that was already named', async () => {
      const { id } = await service.createSession();
      await service.renameSession(id, 'Named up front');
      await service.send(id, 'what is a monad');

      await new Promise(resolve => setTimeout(resolve, 20));
      expect(titleCall()).toBeUndefined();
      expect((await service.getSession(id))?.title).toBe('Named up front');
    });
  });
});
