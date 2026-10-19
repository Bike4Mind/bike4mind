import { describe, it, expect, vi } from 'vitest';
import { ImageModels, ModelInfo, getQuestErrorCode } from '@bike4mind/common';
import { usdToCredits } from '@bike4mind/utils';
import { validateUserCredits } from './utils';

const logger = { updateMetadata: vi.fn(), error: vi.fn() } as never;
const fluxModel = { id: ImageModels.FLUX_PRO } as ModelInfo;

describe('validateUserCredits', () => {
  it('returns the n-scaled usd cost alongside the credits charged', async () => {
    const user = { id: 'u1', currentCredits: 1_000_000 };
    const { requiredCredits, usdCost } = await validateUserCredits(user, fluxModel, 2, { model: fluxModel.id }, logger);
    expect(usdCost).toBeGreaterThan(0);
    expect(requiredCredits).toBe(usdToCredits(usdCost));
  });

  it('still rejects when the owner lacks credits', async () => {
    const user = { id: 'u1', currentCredits: 0 };
    await expect(validateUserCredits(user, fluxModel, 1, { model: fluxModel.id }, logger)).rejects.toThrow(
      /enough personal credits/
    );
  });

  it('tags the credit rejection with the insufficient_credits classifier for the CTA', async () => {
    const user = { id: 'u1', currentCredits: 0 };
    // The tag is what the tool-batch executor keys off to end the turn and what
    // ChatCompletionProcess copies onto quest.errorCode to render the Add Credits CTA.
    const err = await validateUserCredits(user, fluxModel, 1, { model: fluxModel.id }, logger).catch(e => e);
    expect(getQuestErrorCode(err)).toBe('insufficient_credits');
  });
});

describe('validateUserCredits image quality tiers', () => {
  const gptImage2 = { id: ImageModels.GPT_IMAGE_2 } as ModelInfo;

  // The chat image_generation tool bills through validateUserCredits, so the tier it resolved
  // must survive to here. Before the fix a client-pinned imageConfig.quality shadowed the
  // tool call, so every tier on one model billed identically (120 credits - the flat FLUX price).
  it('bills two quality tiers on one GPT-image model differently', async () => {
    const user = { id: 'u1', currentCredits: 1_000_000 };
    const high = await validateUserCredits(user, gptImage2, 1, { model: gptImage2.id, quality: 'high' }, logger);
    const low = await validateUserCredits(user, gptImage2, 1, { model: gptImage2.id, quality: 'low' }, logger);

    // gpt-image-2 high_1024x1024 = $0.211, low_1024x1024 = $0.006, at 2000 credits/USD.
    expect(high.requiredCredits).toBe(usdToCredits(0.211));
    expect(low.requiredCredits).toBe(usdToCredits(0.006));
    expect(high.requiredCredits).toBeGreaterThan(low.requiredCredits);
  });

  // Documents why the chat path looked tier-blind for the reporter: the default FLUX model's
  // price table has no quality dimension, so it bills one flat price at every tier.
  it('bills a quality-blind FLUX model flat across tiers', async () => {
    const user = { id: 'u1', currentCredits: 1_000_000 };
    const high = await validateUserCredits(user, fluxModel, 1, { model: fluxModel.id, quality: 'high' }, logger);
    const low = await validateUserCredits(user, fluxModel, 1, { model: fluxModel.id, quality: 'low' }, logger);

    expect(high.requiredCredits).toBe(low.requiredCredits);
  });
});
