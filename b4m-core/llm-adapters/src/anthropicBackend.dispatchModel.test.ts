/**
 * Catalog-record consumption on the Anthropic request builder (spec 5.4).
 *
 * The adapter table wins for every id it lists, which is the no-behavior-change
 * property. A model only the catalog knows gets its thinking shape and its
 * sampling gate from the record instead of from an id substring nobody updated.
 */

import { describe, expect, it } from 'vitest';
import { ChatModels, type ModelInfo } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';

function buildBackend() {
  const backend = new AnthropicBackend('test-key');
  const captured: Array<Record<string, unknown>> = [];
  (backend as unknown as { _api: unknown })._api = {
    messages: {
      create: async (apiParams: Record<string, unknown>) => {
        captured.push(apiParams);
        return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
  return { backend, captured };
}

function record(id: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: id as ModelInfo['id'],
    type: 'text',
    name: id,
    backend: 'anthropic',
    contextWindow: 200_000,
    max_tokens: 64_000,
    supportsImageVariation: false,
    pricing: {},
    ...overrides,
  };
}

async function run(backend: AnthropicBackend, model: string, options: Record<string, unknown> = {}) {
  await backend.complete(
    model,
    [{ role: 'user', content: 'hi' }],
    { maxTokens: 1024, temperature: 0.3, topP: 0.5, topK: 40, ...options },
    async () => {}
  );
}

describe('AnthropicBackend with no catalog record', () => {
  it('sends the sampling params for a listed model', async () => {
    const { backend, captured } = buildBackend();
    await run(backend, ChatModels.CLAUDE_4_5_HAIKU);
    expect(captured[0]).toMatchObject({ temperature: 0.3, top_k: 40 });
  });

  it('omits every sampling param for a listed adaptive-surface model', async () => {
    const { backend, captured } = buildBackend();
    await run(backend, ChatModels.CLAUDE_5_SONNET);
    expect(captured[0]).not.toHaveProperty('temperature');
    expect(captured[0]).not.toHaveProperty('top_p');
    expect(captured[0]).not.toHaveProperty('top_k');
  });

  it('omits top_k for claude-3-7 and keeps temperature', async () => {
    const { backend, captured } = buildBackend();
    await run(backend, ChatModels.CLAUDE_3_7_SONNET_ANTHROPIC);
    expect(captured[0]).not.toHaveProperty('top_k');
    expect(captured[0]).toMatchObject({ temperature: 0.3 });
  });
});

describe('AnthropicBackend with a catalog record', () => {
  it('leaves a listed model on the adapter table', async () => {
    const { backend, captured } = buildBackend();
    // A record claiming the adaptive surface must not silence a model the table lists.
    backend.setDispatchModel(record(ChatModels.CLAUDE_4_5_HAIKU, { thinkingStyle: 'adaptive', can_think: true }));
    await run(backend, ChatModels.CLAUDE_4_5_HAIKU);
    expect(captured[0]).toMatchObject({ temperature: 0.3, top_k: 40 });
  });

  it('drops top_k for a model only the catalog knows', async () => {
    const { backend, captured } = buildBackend();
    backend.setDispatchModel(record('claude-sonnet-9'));
    await run(backend, 'claude-sonnet-9');
    expect(captured[0]).not.toHaveProperty('top_k');
    expect(captured[0]).toMatchObject({ temperature: 0.3 });
  });

  it('drops every sampling param when the record says the thinking style is adaptive', async () => {
    const { backend, captured } = buildBackend();
    backend.setDispatchModel(record('claude-opus-9', { can_think: true, thinkingStyle: 'adaptive' }));
    await run(backend, 'claude-opus-9');
    expect(captured[0]).not.toHaveProperty('temperature');
    expect(captured[0]).not.toHaveProperty('top_p');
    expect(captured[0]).not.toHaveProperty('top_k');
  });

  it('applies the adaptive thinking shape for a model only the catalog knows', async () => {
    const { backend, captured } = buildBackend();
    backend.setDispatchModel(record('claude-opus-9', { can_think: true, thinkingStyle: 'adaptive' }));
    await run(backend, 'claude-opus-9', { thinking: { enabled: true, budget_tokens: 8000 } });
    expect(captured[0].thinking).toEqual({ type: 'adaptive' });
  });

  it('ignores a record describing a different model', async () => {
    const { backend, captured } = buildBackend();
    backend.setDispatchModel(record('claude-opus-9', { can_think: true, thinkingStyle: 'adaptive' }));
    await run(backend, ChatModels.CLAUDE_4_5_HAIKU);
    expect(captured[0]).toMatchObject({ temperature: 0.3, top_k: 40 });
  });
});
