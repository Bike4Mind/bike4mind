import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatModelOption } from '@shared/chat';
import type { ModelLoadSettings } from '@shared/modelSettings';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import type { ModelCatalog } from './ModelCatalog';
import { ollamaControls } from './modelControls';
import { forgetLocalContexts, OllamaLocal } from './OllamaLocal';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

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
