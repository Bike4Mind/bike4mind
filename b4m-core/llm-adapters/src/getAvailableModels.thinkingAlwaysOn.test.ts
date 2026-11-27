import { beforeEach, describe, expect, it } from 'vitest';
import { ChatModels, ModelBackend } from '@bike4mind/common';
import { getAvailableModels, setModelPriceRowsProvider } from './index';

const KEYS = { [ModelBackend.Anthropic]: 'anthropic-key', [ModelBackend.Kimi]: 'kimi-key' };

beforeEach(() => {
  // Also resets the module-level model cache.
  setModelPriceRowsProvider(null);
});

describe('getAvailableModels thinkingAlwaysOn', () => {
  it('flags the models whose thinking cannot be switched off, from the real adapter tables', async () => {
    const models = await getAvailableModels(KEYS, { isSelfHost: false });
    const byId = new Map(models.map(m => [m.id, m]));

    expect(byId.get(ChatModels.CLAUDE_5_5_OPUS)?.thinkingAlwaysOn).toBe(true);
    expect(byId.get(ChatModels.KIMI_K2_7_CODE)?.thinkingAlwaysOn).toBe(true);
    expect(byId.get(ChatModels.CLAUDE_5_OPUS)).toBeDefined();
    expect(byId.get(ChatModels.CLAUDE_5_OPUS)).not.toHaveProperty('thinkingAlwaysOn');
  });
});
