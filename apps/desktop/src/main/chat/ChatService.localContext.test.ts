import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatStreamEvent } from '@shared/chat';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { COMPACT_MAX_TOKENS } from './compaction';
import type { ModelCatalog } from './ModelCatalog';
import { OllamaLocal } from './OllamaLocal';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

const services: ChatService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.unstubAllGlobals();
});

it('uses measured Ollama input tokens to compact before the next local turn', async () => {
  const requests: { options?: { num_predict?: number } }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith('/api/show'))
        return Response.json({ capabilities: ['completion'], model_info: { 'llama.context_length': 100 } });
      requests.push(JSON.parse(String(init?.body)) as { options?: { num_predict?: number } });
      return new Response(
        `${JSON.stringify({
          message: { content: 'A useful summary of the conversation and its current state.' },
          done: true,
          prompt_eval_count: 90,
          eval_count: 12,
        })}\n`
      );
    })
  );
  const model = 'local:ollama:llama3.2';
  const option = { id: model, name: 'Local', supportsTools: false, contextWindow: 100 };
  const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-local-context-')), model);
  const events: ChatStreamEvent[] = [];
  const service = new ChatService({
    store,
    local: new OllamaLocal(),
    access: { list: async () => [] } as unknown as AccessStore,
    models: {
      cached: () => [option],
      listLocal: async () => [option],
      list: async () => ({ models: [option] }),
    } as unknown as ModelCatalog,
    getApiClient: () => null,
    getEnvironmentUrl: () => '',
    logger: { debug: vi.fn(), warn: vi.fn() },
    emit: event => events.push(event),
  });
  services.push(service);
  const { id } = await service.createSession();
  await service.renameSession(id, 'Keep title');
  expect(await service.send(id, 'first prompt')).toMatchObject({ ok: true });
  await vi.waitUntil(() => !service.isSessionBusy(id));
  expect((await store.get(id))?.messages.at(-1)?.usage).toMatchObject({ inputTokens: 90, outputTokens: 12 });
  expect(await service.send(id, 'second prompt')).toMatchObject({ ok: true });
  await vi.waitUntil(() => !service.isSessionBusy(id));
  expect(requests).toHaveLength(3);
  expect(requests[1].options?.num_predict).toBe(COMPACT_MAX_TOKENS);
  expect(events).toContainEqual({ type: 'auto-compact', sessionId: id, running: true });
  expect((await store.get(id))?.messages.some(message => message.boundary)).toBe(true);
});
