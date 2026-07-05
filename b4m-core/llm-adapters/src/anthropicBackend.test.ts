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

  it('leaves the shipping flagship (claude-opus-4-8) selectable', async () => {
    const models = await new AnthropicBackend('test-key').getModelInfo();
    const opus = models.find(m => m.id === ChatModels.CLAUDE_4_8_OPUS);

    expect(opus, 'claude-opus-4-8 should be present').toBeDefined();
    expect(opus?.disabled).toBeFalsy();
  });
});
