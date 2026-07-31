/**
 * The Anthropic SDK refuses a non-streaming request whose max_tokens implies it could
 * run past its 10-minute ceiling, throwing before any HTTP call is made:
 *
 *   _calculateNonstreamingTimeout(maxTokens):
 *     expectedTimeout = 60min * maxTokens / 128000
 *     if (expectedTimeout > 10min) throw AnthropicError('Streaming is required ...')
 *
 * which puts the real limit at 128000 * 10 / 60 = 21333 tokens.
 *
 * That made a large budget plus stream:false an unconditional failure rather than a
 * long request. It surfaced when adaptive models started defaulting to the 64K
 * ADAPTIVE_THINKING_MAX_TOKENS_FLOOR: every non-streaming Opus 5 turn died with a
 * generic error and no output tokens. The same trap predates that default via
 * buildThinkingParams, which sizes adaptive max_tokens at the same floor whenever
 * thinking is enabled.
 *
 * These cases pin the clamp: non-streaming requests are trimmed to a budget the SDK
 * will accept, and streaming requests keep the full budget.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import type { ICompletionOptions } from './backend';

const SENTINEL = new Error('captured-params-sentinel');

/** Mirrors the SDK guard, so the assertions fail if its formula is ever retuned. */
function sdkWouldReject(maxTokens: number): boolean {
  return (60 * 60 * maxTokens) / 128_000 > 10 * 60;
}

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
  // Opus 5 is adaptive; the legacy-thinking cases need a model that still takes an
  // explicit budget_tokens, which is the shape the clamp has to keep consistent.
  model: string = ChatModels.CLAUDE_5_OPUS
): Promise<void> {
  try {
    await backend.complete(model, [{ role: 'user', content: 'hi' }], options, async () => undefined);
  } catch (err) {
    if (err !== SENTINEL) throw err;
  }
}

describe('AnthropicBackend non-streaming max_tokens ceiling', () => {
  it('clamps a 64K budget on a non-streaming request to something the SDK accepts', async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(backend, { stream: false, maxTokens: 64_000 });

    const sent = getCaptured()[0].max_tokens as number;
    expect(sent).toBeLessThan(64_000);
    expect(sdkWouldReject(sent)).toBe(false);
  });

  it('leaves a modest non-streaming budget untouched', async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(backend, { stream: false, maxTokens: 4096 });

    expect(getCaptured()[0].max_tokens).toBe(4096);
  });

  // The clamp is a workaround for a non-streaming-only limit; streaming has no such
  // ceiling, so the full budget must survive or adaptive models lose their headroom.
  it('preserves the full budget when streaming', async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(backend, { stream: true, maxTokens: 64_000 });

    expect(getCaptured()[0].max_tokens).toBe(64_000);
  });

  // A legacy thinking budget is spent inside max_tokens, and the API rejects a budget
  // that is not strictly below it. Lowering only the ceiling would swap the SDK's error
  // for a 400 - still no answer, just a more confusing one.
  it('brings a legacy thinking budget down with the ceiling', async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(backend, {
      stream: false,
      thinking: { enabled: true, budget_tokens: 30_000 },
    } as Partial<ICompletionOptions>, ChatModels.CLAUDE_4_6_OPUS);

    const sent = getCaptured()[0];
    const maxTokens = sent.max_tokens as number;
    const budget = (sent.thinking as { budget_tokens: number }).budget_tokens;
    expect(budget).toBeLessThan(maxTokens);
    expect(sdkWouldReject(maxTokens)).toBe(false);
    // Anthropic's own floor for a thinking budget.
    expect(budget).toBeGreaterThanOrEqual(1024);
  });

  // A budget that merely squeaks under the ceiling satisfies the API but starves the
  // answer to a token or two, which is the same empty reply the clamp exists to avoid.
  it('claws back the answer headroom from a budget that only just fits', async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(
      backend,
      { stream: false, thinking: { enabled: true, budget_tokens: 20_999 } } as Partial<ICompletionOptions>,
      ChatModels.CLAUDE_4_6_OPUS
    );

    const sent = getCaptured()[0];
    const maxTokens = sent.max_tokens as number;
    const budget = (sent.thinking as { budget_tokens: number }).budget_tokens;
    expect(maxTokens - budget).toBeGreaterThanOrEqual(1000);
  });

  it('leaves a legacy thinking budget alone when streaming', async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(backend, {
      stream: true,
      thinking: { enabled: true, budget_tokens: 30_000 },
    } as Partial<ICompletionOptions>, ChatModels.CLAUDE_4_6_OPUS);

    const sent = getCaptured()[0];
    expect((sent.thinking as { budget_tokens: number }).budget_tokens).toBe(30_000);
    expect(sent.max_tokens).toBe(31_000);
  });
});
