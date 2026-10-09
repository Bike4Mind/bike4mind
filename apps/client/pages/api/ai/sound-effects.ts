import {
  ApiKeyType,
  shouldPersistGeneratedAudio,
  generateSoundEffectContract,
  SoundGenerationVendor,
} from '@bike4mind/common';
import { adminSettingsRepository, apiKeyRepository, usageEventRepository } from '@bike4mind/database';
import { apiKeyService, estimateSoundCredits } from '@bike4mind/services';
import { aiSoundService, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { reserveRequestCredits } from '@server/billing/reserveRequestCredits';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { persistGeneratedAudio } from '@server/utils/persistGeneratedAudio';
import { deliverGeneratedAudio } from '@server/utils/generatedAudioDelivery';
import { resolveRequestUsageSource } from '@server/utils/resolveRequestUsageSource';

// The stored key type each vendor needs. Resolved per-user first, then falling
// back to the admin-configured key (getEffectiveApiKey), so the feature works
// out of the box on platforms that provide a shared provider key.
const PROVIDER_API_KEY_TYPE: Record<SoundGenerationVendor, ApiKeyType> = {
  elevenlabs: ApiKeyType.elevenlabs,
};

// Provider-agnostic sound-effects generation. Meters usage: because the cost is
// deterministic (duration-driven), it RESERVES the exact charge before calling
// the provider and settles it on success / refunds it on failure - so a charge
// can never fail after the audio is produced. Bills the organization's shared
// pool for org-billed API keys and for org-seat members; otherwise the user. All
// billing is gated on the enforceCredits admin setting, so self-host /
// credits-off deployments run free. Scope-gated (AI_GENERATE) so an under-scoped
// API key can't drive paid provider generation, matching image/video.
//
// Auth mode, required scopes, and request validation all come from
// generateSoundEffectContract (the same source of truth that drives the OpenAPI
// spec); `req.validated` is the parsed, typed body.
const handler = nextRouteForContract(generateSoundEffectContract).post(async (req, res) => {
  const { provider, text, durationSeconds, promptInfluence, format, encoding, preview } = req.validated;
  const userId = req.user?.id;

  const apiKey = await apiKeyService.getEffectiveApiKey(
    userId,
    { type: PROVIDER_API_KEY_TYPE[provider] },
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } }
  );

  if (!apiKey) {
    // 503, not 401: the caller IS authenticated - the provider key is a server-side
    // capability gap. A 401 would tell an API-key caller to re-authenticate, which
    // never fixes a missing ElevenLabs key. The message survives to the CLI via the
    // arraybuffer error decode + mapApiError's server-message fallback.
    return res.status(503).json({ error: `No ${provider} API key configured` });
  }

  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, { names: ['enforceCredits'] });
  const enforceCredits = getSettingsValue('enforceCredits', settings);

  // Cost is deterministic from the request (duration-driven), so the same
  // estimate drives the reservation, the settlement, and the usage-event COGS -
  // it's computed regardless of enforceCredits so analytics capture true provider
  // cost even on credits-off / self-host deployments.
  const { requiredCredits, usdCost, billedSeconds } = estimateSoundCredits(provider, { durationSeconds });

  const reservation = await reserveRequestCredits({
    req,
    requiredCredits,
    enforceCredits,
    featureLabel: 'sound generation',
  });
  const { ownerId: creditOwnerId, ownerType: creditOwnerType } = reservation;

  const sessionId = `sound-effects-${userId}-${Date.now()}`;
  const source = resolveRequestUsageSource(req);

  // Analytics is never part of the billing path: one usage event per provider
  // call (ok or error), independent of enforceCredits and of whether the charge
  // succeeds. Fire-and-forget; a logging failure never affects the response.
  const recordUsage = (status: 'ok' | 'error', creditsCharged: number, costUsdValue: number) =>
    usageEventRepository
      .record({
        requestId: sessionId,
        userId,
        ownerId: creditOwnerId,
        ownerType: creditOwnerType,
        sessionId,
        feature: 'sound_effects',
        provider,
        model: provider,
        // Matches this call's ledger write (deductCreditsWithOrgSupport).
        source,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        // Effective billed duration, not the raw request field: an omitted
        // duration is billed at the vendor auto-duration default, so recording
        // the request's `undefined` (as 0) would desync units from costUsd.
        units: billedSeconds,
        costUsd: costUsdValue,
        creditsCharged,
        status,
      })
      .catch(err => req.logger.warn('Failed to record sound-effects usage event', { err }));

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
    // Refund the reserved credits - a failed generation incurs no provider cost.
    await reservation.refund();
    recordUsage('error', 0, 0);
    return res.status(502).json({ error: 'Sound generation failed' });
  }

  // Settle the full reservation: the provider generates exactly the billed duration.
  const creditsCharged = await reservation.settle(reservation.reservedCredits, {
    type: 'sound_effects_usage',
    sessionId,
    model: provider,
    source,
  });

  recordUsage('ok', creditsCharged, usdCost);

  // Best-effort browsable copy (on by default; opt out via the saveGeneratedAudio
  // preference or `preview`): a save failure never blocks returning audio the
  // caller was already charged for.
  const save =
    userId &&
    shouldPersistGeneratedAudio({ userId, saveGeneratedAudio: req.user?.preferences?.saveGeneratedAudio, preview })
      ? await persistGeneratedAudio({
          userId,
          audio,
          contentType,
          format,
          source: 'sound-effect',
          text,
          logger: req.logger,
        })
      : undefined;

  return deliverGeneratedAudio(res, { audio, contentType, encoding: encoding ?? 'binary', save, logger: req.logger });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
