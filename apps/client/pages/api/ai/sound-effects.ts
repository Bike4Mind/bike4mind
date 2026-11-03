import { createModelAdmission } from '@server/billing/meterPlatformCompletion';
import { DEFAULT_SOUND_MODEL_ID } from '@bike4mind/common';
import { randomUUID } from 'crypto';
import {
  isSupportedElevenLabsFormat,
  UnprocessableEntityError,
  shouldPersistGeneratedAudio,
  generateSoundEffectContract,
  SoundGenerationVendor,
  usdToCreditsStochastic,
} from '@bike4mind/common';
import { adminSettingsRepository, apiKeyRepository, cacheRepository, usageEventRepository } from '@bike4mind/database';
import { apiKeyService, estimateSoundCredits, ProviderBusyError, runElevenLabsWithCapacity } from '@bike4mind/services';
import { aiSoundService, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { reserveRequestCredits } from '@server/billing/reserveRequestCredits';
import { resolveAudioBillingOrgId } from '@server/billing/resolveAudioBillingOrgId';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { providerBusyHttpError } from '@server/utils/providerBusyHttpError';
import { saveGeneratedAssetToFiles } from '@bike4mind/server-utils/utils/saveGeneratedAssetToFiles';
import { deliverGeneratedAudio } from '@server/utils/generatedAudioDelivery';
import { resolveRequestUsageSource } from '@server/utils/resolveRequestUsageSource';
import { AUDIO_VENDOR_API_KEY_TYPE } from '@server/utils/audioVendorApiKeyType';

// Each vendor's output-format check. Run before the reservation: an unmapped codec would be generated and
// billed, then could be neither labelled nor saved.
const SUPPORTS_OUTPUT_FORMAT: Record<SoundGenerationVendor, (format: string) => boolean> = {
  elevenlabs: isSupportedElevenLabsFormat,
};

// Provider-agnostic sound-effects generation. Meters usage: because the cost is
// deterministic (duration-driven), it RESERVES the rounded-up charge before
// calling the provider and settles the exact cost on success / refunds it on failure - so a charge
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
  const { provider, text, durationSeconds, promptInfluence, format, encoding, preview, organization_id } =
    req.validated;
  const userId = req.user?.id;

  // Undefined falls back to the vendor's mp3 default, which every vendor supports. An empty string is
  // checked too: the generators keep it (`??`), so it would otherwise fail only after the reservation.
  if (format !== undefined && !SUPPORTS_OUTPUT_FORMAT[provider](format)) {
    throw new UnprocessableEntityError(`The ${provider} provider does not support the '${format}' output format`);
  }

  await (await createModelAdmission(req.user!)).assert(DEFAULT_SOUND_MODEL_ID);

  const apiKey = await apiKeyService.getEffectiveApiKey(
    userId,
    { type: AUDIO_VENDOR_API_KEY_TYPE[provider] },
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } }
  );

  if (!apiKey) {
    // 503, not 401: the caller IS authenticated - the provider key is a server-side
    // capability gap. A 401 would tell an API-key caller to re-authenticate, which
    // never fixes a missing ElevenLabs key. The message survives to the CLI via the
    // arraybuffer error decode + mapApiError's server-message fallback.
    return res.status(503).json({ error: `No ${provider} API key configured` });
  }

  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['enforceCredits'], skipCache: true }
  );
  const enforceCredits = getSettingsValue('enforceCredits', settings);

  // Cost is deterministic from the request (duration-driven), so the same
  // estimate drives the reservation, the settlement, and the usage-event COGS -
  // it's computed regardless of enforceCredits so analytics capture true provider
  // cost even on credits-off / self-host deployments.
  const { requiredCredits, usdCost, billedSeconds } = estimateSoundCredits(provider, { durationSeconds });

  // Omitted keeps the home-org default. A key bills its own account (resolveAudioBillingOrgId 403s any
  // other target), so only the JWT caller's value changes the payer.
  const billingOrganizationId = await resolveAudioBillingOrgId(req, organization_id, 'home-org');

  const reservation = await reserveRequestCredits({
    req,
    requiredCredits,
    enforceCredits,
    featureLabel: 'sound generation',
    billingOrganizationId,
  });
  const { ownerId: creditOwnerId, ownerType: creditOwnerType } = reservation;

  const sessionId = `sound-effects-${userId}-${randomUUID()}`;
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
    ({ audio, contentType } = await runElevenLabsWithCapacity(
      {
        operation: 'sound',
        apiKey,
        db: { adminSettings: adminSettingsRepository, caches: cacheRepository },
        logger: req.logger,
      },
      ({ timeoutMs }) =>
        aiSoundService(provider, apiKey, req.logger, { timeoutMs }).generate(text, {
          durationSeconds,
          promptInfluence,
          format,
        })
    ));
  } catch (error) {
    // Log before refunding, so a refund that throws cannot swallow the original failure.
    if (error instanceof ProviderBusyError) {
      req.logger.warn('Sound-effects generation deferred: provider at capacity', { provider, reason: error.reason });
      // Refund the reserved credits - a failed generation incurs no provider cost.
      await reservation.refund();
      // Only a 429'd attempt reached the provider; a request that never got a slot made no call to record.
      if (error.reason === 'upstream_rate_limited') recordUsage('error', 0, 0);
      throw providerBusyHttpError(error);
    }
    req.logger.error('Sound-effects generation failed', {
      provider,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    await reservation.refund();
    recordUsage('error', 0, 0);
    return res.status(502).json({ error: 'Sound generation failed' });
  }

  // The provider generates exactly the billed duration, so settle that exact cost; the round-up held at
  // reservation is refunded.
  const creditsCharged = await reservation.settle(usdToCreditsStochastic(usdCost), {
    type: 'sound_effects_usage',
    sessionId,
    model: provider,
    source,
  });

  recordUsage('ok', creditsCharged, usdCost);

  // Best-effort browsable copy, skipped only for a throwaway `preview` call: a
  // save failure never blocks returning audio the caller was already charged for.
  const save =
    userId && shouldPersistGeneratedAudio({ userId, preview })
      ? await saveGeneratedAssetToFiles(
          {
            userId,
            bytes: audio,
            contentType,
            generation: {
              generator: 'sound_effect',
              provider,
              prompt: text,
              ...(durationSeconds !== undefined && { durationSeconds }),
              ...(promptInfluence !== undefined && { promptInfluence }),
              request: {
                provider,
                text,
                ...(durationSeconds !== undefined && { durationSeconds }),
                ...(promptInfluence !== undefined && { promptInfluence }),
                ...(format !== undefined && { format }),
              },
            },
          },
          req.logger
        )
      : undefined;

  return deliverGeneratedAudio(res, { audio, contentType, encoding: encoding ?? 'binary', save, logger: req.logger });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
