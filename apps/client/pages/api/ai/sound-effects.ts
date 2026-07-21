import {
  ApiKeyType,
  CreditHolderType,
  insufficientCreditsError,
  SoundGenerationVendor,
  soundEffectsRequestSchema,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  apiKeyRepository,
  creditTransactionRepository,
  userRepository,
  usageEventRepository,
} from '@bike4mind/database';
import { apiKeyService, creditService, estimateSoundCredits } from '@bike4mind/services';
import { aiSoundService, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';

// The stored key type each vendor needs. Resolved per-user first, then falling
// back to the admin-configured key (getEffectiveApiKey), so the feature works
// out of the box on platforms that provide a shared provider key.
const PROVIDER_API_KEY_TYPE: Record<SoundGenerationVendor, ApiKeyType> = {
  elevenlabs: ApiKeyType.elevenlabs,
};

// Provider-agnostic sound-effects generation. Meters usage: estimates the
// credit cost up front (rejecting when the balance is short), then charges the
// user after a successful generation. All billing is gated on the enforceCredits
// admin setting, so self-host / credits-off deployments run free.
const handler = baseApi().post(async (req, res) => {
  const { provider, text, durationSeconds, promptInfluence, format } = soundEffectsRequestSchema.parse(req.body);
  const userId = req.user?.id;

  const apiKey = await apiKeyService.getEffectiveApiKey(
    userId,
    { type: PROVIDER_API_KEY_TYPE[provider] },
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } }
  );

  if (!apiKey) {
    return res.status(401).json({ error: `No ${provider} API key configured` });
  }

  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, { names: ['enforceCredits'] });
  const enforceCredits = getSettingsValue('enforceCredits', settings);

  // The credit cost is deterministic from the request (duration-driven), so the
  // pre-check estimate is also the exact amount charged after success.
  let requiredCredits = 0;
  let usdCost = 0;
  if (enforceCredits) {
    ({ requiredCredits, usdCost } = estimateSoundCredits(provider, { durationSeconds }));
    const user = await userRepository.findById(userId);
    if (!user) throw new BadRequestError('User not found');
    if ((user.currentCredits ?? 0) < requiredCredits) {
      throw insufficientCreditsError(
        `You do not have enough credits for sound generation. You currently have ${user.currentCredits ?? 0} credits and this requires approximately ${requiredCredits}.`
      );
    }
  }

  let audio: Buffer;
  let contentType: string;
  try {
    const soundService = aiSoundService(provider, apiKey, req.logger);
    ({ audio, contentType } = await soundService.generate(text, { durationSeconds, promptInfluence, format }));
  } catch (error) {
    req.logger.error('Sound-effects generation failed', {
      provider,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return res.status(502).json({ error: 'Sound generation failed' });
  }

  // Charge only after a successful generation. A billing failure here is
  // non-fatal (the audio was produced) but logged so a missed charge is visible.
  if (enforceCredits && requiredCredits > 0) {
    const sessionId = `sound-effects-${userId}-${Date.now()}`;
    try {
      await creditService.subtractCredits(
        {
          type: 'sound_effects_usage',
          ownerId: userId,
          ownerType: CreditHolderType.User,
          credits: requiredCredits,
          model: provider,
          sessionId,
        },
        { db: { creditTransactions: creditTransactionRepository }, creditHolderMethods: userRepository }
      );

      // Dual-write a usage event for analytics; never billing, never fatal.
      usageEventRepository
        .record({
          requestId: sessionId,
          userId,
          ownerId: userId,
          ownerType: CreditHolderType.User,
          sessionId,
          feature: 'sound_effects',
          provider,
          model: provider,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          units: durationSeconds ?? 0,
          costUsd: usdCost,
          creditsCharged: requiredCredits,
          status: 'ok',
        })
        .catch(err => req.logger.warn('Failed to record sound-effects usage event', { err }));
    } catch (err) {
      req.logger.error('Sound-effects credit deduction failed - billing may be missed', {
        userId,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', audio.length);
  return res.send(audio);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
