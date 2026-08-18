import { describe, it, expect } from 'vitest';
import { AnthropicBackend } from './anthropicBackend';
import { ChatModels } from '@bike4mind/common';

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
});
