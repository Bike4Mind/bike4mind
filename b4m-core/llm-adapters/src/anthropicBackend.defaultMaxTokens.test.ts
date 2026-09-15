/**
 * The output budget this backend picks when the CALLER names none.
 *
 * An adaptive model spends reasoning inside max_tokens on every turn, not only when a
 * caller explicitly enables thinking. The flat `?? 4096` fallback this replaces therefore
 * starved every in-process caller that passes no budget - agent mode, subagent
 * orchestrators, deepAgent - and their answers were cut off mid-sentence. The 64K floor
 * used to be reachable only through buildThinkingParams, i.e. only with thinking enabled.
 *
 * Models that do NOT reason inside the output budget must keep the historical 4096
 * exactly; that parity is what makes this safe to change in a shared backend.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels, ModelBackend, type ModelInfo } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import type { ICompletionOptions } from './backend';
import { ADAPTIVE_THINKING_MAX_TOKENS_FLOOR } from './thinkingParams';

const SENTINEL = new Error('captured-params-sentinel');

function buildBackend() {
  const backend = new AnthropicBackend('test-key');
  const captured: Record<string, unknown>[] = [];
  (backend as unknown as { _api: unknown })._api = {
    messages: {
      create: async (apiParams: Record<string, unknown>) => {
        captured.push(apiParams);
        throw SENTINEL;
      },
      stream: (apiParams: Record<string, unknown>) => {
        captured.push(apiParams);
        throw SENTINEL;
      },
    },
  };
  return { backend, getCaptured: () => captured };
}

async function runComplete(
  backend: AnthropicBackend,
  options: Partial<ICompletionOptions>,
  model: string
): Promise<void> {
  try {
    await backend.complete(model, [{ role: 'user', content: 'hi' }], options, async () => undefined);
  } catch (err) {
    if (err !== SENTINEL) throw err;
  }
}

describe('AnthropicBackend default max_tokens', () => {
  it('sizes an absent budget to the adaptive floor for a reasoning model', async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(backend, { stream: true }, ChatModels.CLAUDE_5_OPUS);

    // Previously 4096, which reasoning alone could consume.
    expect(getCaptured()[0].max_tokens).toBe(ADAPTIVE_THINKING_MAX_TOKENS_FLOOR);
  });

  // Reached WITHOUT enabling thinking - the gap being closed. buildThinkingParams (and its
  // 64K floor) only runs when a caller opts in, so this path had no sizing at all.
  it('does not send a thinking config just because the budget was sized', async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(backend, { stream: true }, ChatModels.CLAUDE_5_OPUS);

    expect(getCaptured()[0].thinking).toBeUndefined();
  });

  it('keeps the historical 4096 for a model that does not reason inside the budget', async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(backend, { stream: true }, ChatModels.CLAUDE_4_5_SONNET);

    expect(getCaptured()[0].max_tokens).toBe(4096);
  });

  it('never raises a budget the caller asked for explicitly', async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(backend, { stream: true, maxTokens: 1000 }, ChatModels.CLAUDE_5_OPUS);

    expect(getCaptured()[0].max_tokens).toBe(1000);
  });

  // Parity with the cliCompletions call site: the model's declared cap CLAMPS the sized
  // budget, so the floor applies only up to what the model can actually emit. Reachable
  // through the catalog-only branch of modelRecordFor, since every adaptive model in the
  // adapter table declares 128K.
  it('clamps the sized budget to a catalog-only adaptive cap below the floor', async () => {
    const { backend, getCaptured } = buildBackend();
    backend.setDispatchModel({
      id: 'catalog-only-adaptive',
      type: 'text',
      name: 'Catalog Only Adaptive',
      backend: ModelBackend.Anthropic,
      contextWindow: 200_000,
      max_tokens: 16_000,
      can_stream: true,
      can_think: true,
      thinkingStyle: 'adaptive',
      pricing: {},
    } as ModelInfo);

    await runComplete(backend, { stream: true }, 'catalog-only-adaptive');

    expect(getCaptured()[0].max_tokens).toBe(16_000);
  });

  // The sized default must not defeat the SDK's non-streaming duration limit; the existing
  // ANTHROPIC_NONSTREAMING_MAX_TOKENS clamp runs after resolution and still applies.
  it('is still clamped for a non-streaming request', async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(backend, { stream: false }, ChatModels.CLAUDE_5_OPUS);

    const sent = getCaptured()[0].max_tokens as number;
    expect(sent).toBeLessThan(ADAPTIVE_THINKING_MAX_TOKENS_FLOOR);
    expect((60 * 60 * sent) / 128_000).toBeLessThanOrEqual(10 * 60);
  });
});
