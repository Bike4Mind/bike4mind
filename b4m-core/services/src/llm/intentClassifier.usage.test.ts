import { describe, it, expect, vi } from 'vitest';
import type { ILogger } from '@bike4mind/observability';
import type { ModelInfo } from '@bike4mind/common';
import type { ApiKeyTable, ICompletionBackend } from '@bike4mind/llm-adapters';
import { classifyIntent } from './intentClassifier';
import { IntentClassifierCache } from './intentClassifier.cache';

const backends = new Map<string, ICompletionBackend>();

vi.mock('@bike4mind/llm-adapters', async () => ({
  ...(await vi.importActual<typeof import('@bike4mind/llm-adapters')>('@bike4mind/llm-adapters')),
  getLlmByModel: (_keys: ApiKeyTable, { modelInfo }: { modelInfo: ModelInfo }) => backends.get(modelInfo.id) ?? null,
}));

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ILogger;
const decisionJson = JSON.stringify({ useAgent: false, confidence: 0.8, reason: 'chat', signals: [] });

type Callback = (text: string[], info?: Record<string, unknown>) => Promise<void>;
const backend = (impl: (cb: Callback) => Promise<void>) =>
  ({
    complete: vi.fn((_m: string, _msgs: unknown, _o: unknown, cb: Callback) => impl(cb)),
  }) as unknown as ICompletionBackend;

function adapters(ids: string[]) {
  return {
    apiKeyTable: {} as ApiKeyTable,
    availableModels: ids.map(id => ({ id, backend: 'anthropic' }) as unknown as ModelInfo),
    logger,
    cache: new IntentClassifierCache(),
    config: { enabled: true, shadowMode: true, primaryModel: ids[0], fallbackModels: ids.slice(1) },
  };
}

describe('classifyIntent usage reporting', () => {
  it('reports every provider call, failed cascade attempts included, and the model that answered', async () => {
    backends.set(
      'model-a',
      backend(async cb => {
        await cb([''], { inputTokens: 40 });
        throw new Error('provider down');
      })
    );
    backends.set(
      'model-b',
      backend(async cb => cb([decisionJson], { inputTokens: 120, outputTokens: 30 }))
    );

    const decision = await classifyIntent({ userId: 'u1', message: 'hi' }, adapters(['model-a', 'model-b']));

    expect(decision.classifierModel).toBe('model-b');
    expect(decision.usage).toEqual([
      { modelId: 'model-a', inputTokens: 40 },
      { modelId: 'model-b', inputTokens: 120, outputTokens: 30 },
    ]);
  });

  it('reports no usage on a cache hit', async () => {
    backends.set(
      'model-a',
      backend(async cb => cb([decisionJson], { inputTokens: 10, outputTokens: 5 }))
    );
    const a = adapters(['model-a']);
    await classifyIntent({ userId: 'u1', message: 'same' }, a);

    const cached = await classifyIntent({ userId: 'u1', message: 'same' }, a);

    expect(cached.cacheHit).toBe(true);
    expect(cached.usage).toEqual([]);
  });
});
