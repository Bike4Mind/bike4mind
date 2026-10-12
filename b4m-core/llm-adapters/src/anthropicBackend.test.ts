import { describe, it, expect } from 'vitest';
import { AnthropicBackend } from './anthropicBackend';
import { ChatModels, getTextModelCost } from '@bike4mind/common';

// getModelInfo() returns a static catalog and makes no network call, so we can construct the
// backend with a dummy key. Fable 5 was gated upstream and is GA as of 2026-07-01.
describe('AnthropicBackend.getModelInfo', () => {
  it('lists claude-fable-5 as selectable now that it is GA (was gated — #8999)', async () => {
    const models = await new AnthropicBackend('test-key').getModelInfo();
    const fable = models.find(m => m.id === ChatModels.CLAUDE_FABLE_5);

    expect(fable, 'claude-fable-5 should remain in the catalog').toBeDefined();
    // No longer gated: the disabled flag and reason were removed when access was granted.
    expect(fable?.disabled).toBeFalsy();
    expect(fable?.disabledReason).toBeUndefined();
  });

  it('leaves the previous flagship (claude-opus-4-8) selectable', async () => {
    const models = await new AnthropicBackend('test-key').getModelInfo();
    const opus = models.find(m => m.id === ChatModels.CLAUDE_4_8_OPUS);

    expect(opus, 'claude-opus-4-8 should be present').toBeDefined();
    expect(opus?.disabled).toBeFalsy();
  });

  it('lists claude-opus-5 with the adaptive-thinking surface and Opus-tier pricing', async () => {
    const models = await new AnthropicBackend('test-key').getModelInfo();
    const opus5 = models.find(m => m.id === ChatModels.CLAUDE_5_OPUS);

    expect(opus5, 'claude-opus-5 should be present').toBeDefined();
    expect(opus5?.disabled).toBeFalsy();
    expect(opus5?.thinkingStyle).toBe('adaptive');
    // Same list price as Opus 4.8: $5/$25 per 1M tokens.
    expect(opus5?.pricing[1_000_000]).toEqual({ input: 5 / 1_000_000, output: 25 / 1_000_000 });
  });

  it('prices claude-haiku-5-5 by prompt length: $0.10/$0.50 up to 100K, $0.50/$2.50 beyond', async () => {
    const models = await new AnthropicBackend('test-key').getModelInfo();
    const haiku55 = models.filter(m => m.id === ChatModels.CLAUDE_5_5_HAIKU);

    expect(haiku55, 'claude-haiku-5-5 should be listed exactly once').toHaveLength(1);
    expect(haiku55[0].thinkingStyle).toBe('adaptive');
    expect(haiku55[0].contextWindow).toBe(1_000_000);
    expect(haiku55[0].max_tokens).toBe(128_000);
    expect(haiku55[0].pricing[100_000]).toEqual({ input: 0.1 / 1_000_000, output: 0.5 / 1_000_000 });
    expect(haiku55[0].pricing[1_000_000]).toEqual({ input: 0.5 / 1_000_000, output: 2.5 / 1_000_000 });
    // Short prompt: 100K in + 1M out + 1M cache read ($0.01/M) + 1M 5m cache write ($0.125/M)
    expect(getTextModelCost(haiku55[0], 100_000, 1_000_000, 1_000_000, 1_000_000)).toBeCloseTo(
      0.01 + 0.5 + 0.01 + 0.125,
      10
    );
    // Long prompt: 100,001 input tokens lands in the upper tier
    expect(getTextModelCost(haiku55[0], 100_001, 1_000_000, 1_000_000, 1_000_000)).toBeCloseTo(
      0.0500005 + 2.5 + 0.05 + 0.625,
      10
    );
  });

  it('prices claude-opus-5-5 natively at $4/$20 per 1M with $0.20 cache reads', async () => {
    const models = await new AnthropicBackend('test-key').getModelInfo();
    const opus55 = models.filter(m => m.id === ChatModels.CLAUDE_5_5_OPUS);

    expect(opus55, 'claude-opus-5-5 should be listed exactly once').toHaveLength(1);
    expect(opus55[0].thinkingStyle).toBe('adaptive');
    expect(opus55[0].pricing[1_000_000]).toEqual({
      input: 4 / 1_000_000,
      output: 20 / 1_000_000,
      cache_read: 0.2 / 1_000_000,
    });
    // 1M input + 1M output + 1M cache read + 1M 5m cache write = $4 + $20 + $0.20 + $5
    expect(getTextModelCost(opus55[0], 1_000_000, 1_000_000, 1_000_000, 1_000_000)).toBeCloseTo(29.2, 10);
  });
});
