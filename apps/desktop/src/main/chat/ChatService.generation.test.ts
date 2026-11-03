import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { ChatModels } from '@bike4mind/common';
import type { ChatModelOption, ReasoningEffortSetting } from '@shared/chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { COMPACT_MAX_TOKENS } from './compaction';
import type { ModelCatalog } from './ModelCatalog';
import { SUGGESTION_INSTRUCTION, SUGGESTION_MAX_TOKENS } from './nextPrompt';
import { forgetLocalContexts, OllamaLocal } from './OllamaLocal';
import { SessionStore } from './SessionStore';
import { TITLE_INSTRUCTION, TITLE_MAX_TOKENS } from './sessionTitle';
import type { AccessStore } from './tools/AccessStore';

/** A conversation's overrides reach its own turns, and never a title, a suggestion or a compaction. */

const services: ChatService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.unstubAllGlobals();
  forgetLocalContexts();
});

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
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-generation-')), model);
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
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-effort-')), option.id);
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
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-generation-local-')), model);
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
