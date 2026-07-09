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
