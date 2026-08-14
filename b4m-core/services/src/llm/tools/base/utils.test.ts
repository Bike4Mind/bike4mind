import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_MUSIC_LENGTH_MS, ImageModels, ModelInfo, getQuestErrorCode } from '@bike4mind/common';
import { usdToCredits } from '@bike4mind/utils';
import { validateMusicCredits, validateUserCredits } from './utils';

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

describe('validateMusicCredits', () => {
  it('returns the deterministic length-driven cost + billed seconds', () => {
    const user = { id: 'u1', currentCredits: 1_000_000 };
    const { requiredCredits, usdCost, billedSeconds } = validateMusicCredits(
      user,
      'elevenlabs',
      DEFAULT_MUSIC_LENGTH_MS,
      logger
    );
    expect(usdCost).toBeGreaterThan(0);
    expect(requiredCredits).toBe(usdToCredits(usdCost));
    expect(billedSeconds).toBe(DEFAULT_MUSIC_LENGTH_MS / 1000);
  });

  it('charges more for a longer track', () => {
    const user = { id: 'u1', currentCredits: 1_000_000 };
    const short = validateMusicCredits(user, 'elevenlabs', 10_000, logger);
    const long = validateMusicCredits(user, 'elevenlabs', 30_000, logger);
    expect(long.requiredCredits).toBeGreaterThan(short.requiredCredits);
  });

  it('rejects (tagged insufficient_credits) when the owner lacks credits', () => {
    const user = { id: 'u1', currentCredits: 0 };
    const err = (() => {
      try {
        validateMusicCredits(user, 'elevenlabs', DEFAULT_MUSIC_LENGTH_MS, logger);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/enough personal credits to generate music/);
    expect(getQuestErrorCode(err)).toBe('insufficient_credits');
  });

  it('bills the organization pool when an organization is passed', () => {
    const user = { id: 'u1', currentCredits: 0 };
    const organization = { id: 'org1', currentCredits: 1_000_000 } as never;
    // User has 0 credits but the org pool covers it - no throw.
    const { requiredCredits } = validateMusicCredits(user, 'elevenlabs', DEFAULT_MUSIC_LENGTH_MS, logger, organization);
    expect(requiredCredits).toBeGreaterThan(0);
  });
});
