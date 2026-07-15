/**
 * Grok 4.5 is the first xAI model with a tiered pricing map, so it is the first
 * to exercise tier selection for this backend: getTextModelCost picks the tier
 * by PROMPT size, and every rate in that tier (output and cache read included)
 * moves with it. These tests drive the real catalog entry across the 200K
 * boundary so a bad threshold key cannot silently bill the cheap tier.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels, getTextModelCost, type ModelInfo } from '@bike4mind/common';
import { XAIBackend } from './xaiBackend';

const findModel = async (id: ChatModels): Promise<ModelInfo> => {
  const models = await new XAIBackend('test-key').getModelInfo();
  const model = models.find(m => m.id === id);
  if (!model) throw new Error(`${id} missing from the xAI catalog`);
  return model;
};

describe('Grok 4.5 tiered pricing', () => {
  it('bills the <= 200K tier at $2 / 1M in, $6 / 1M out, $0.50 / 1M cache read', async () => {
    const model = await findModel(ChatModels.GROK_4_5);

    const cost = getTextModelCost(model, 200_000, 1_000, 10_000);

    expect(cost).toBeCloseTo((200_000 * 2 + 1_000 * 6 + 10_000 * 0.5) / 1_000_000, 10);
  });

  it('bills the > 200K tier at $4 / 1M in, $12 / 1M out, $1 / 1M cache read', async () => {
    const model = await findModel(ChatModels.GROK_4_5);

    const cost = getTextModelCost(model, 200_001, 1_000, 10_000);

    expect(cost).toBeCloseTo((200_001 * 4 + 1_000 * 12 + 10_000 * 1) / 1_000_000, 10);
  });

  it('publishes explicit cache_read rates rather than falling back to the 0.1x input default', async () => {
    const model = await findModel(ChatModels.GROK_4_5);

    // 0.5 / 1M is 0.25x the 2 / 1M input rate, so the default multiplier would
    // under-bill cache reads by more than half.
    expect(model.pricing[200_000].cache_read).toBeCloseTo(0.5 / 1_000_000, 12);
    expect(model.pricing[500_000].cache_read).toBeCloseTo(1 / 1_000_000, 12);
  });
});
