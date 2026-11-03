import { createModelAdmission } from '@server/billing/meterPlatformCompletion';
import { randomUUID } from 'crypto';
import {
  DEFAULT_MUSIC_MODEL_ID,
  ApiKeyType,
  isSupportedElevenLabsFormat,
  UnprocessableEntityError,
  shouldPersistGeneratedAudio,
  generateMusicContract,
  MusicGenerationVendor,
  usdToCreditsStochastic,
} from '@bike4mind/common';
import { adminSettingsRepository, apiKeyRepository, cacheRepository, usageEventRepository } from '@bike4mind/database';
import { apiKeyService, estimateMusicCredits, ProviderBusyError, runElevenLabsWithCapacity } from '@bike4mind/services';
import { aiMusicService, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { reserveRequestCredits } from '@server/billing/reserveRequestCredits';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { providerBusyHttpError } from '@server/utils/providerBusyHttpError';
import { saveGeneratedAssetToFiles } from '@bike4mind/server-utils/utils/saveGeneratedAssetToFiles';
import { deliverGeneratedAudio } from '@server/utils/generatedAudioDelivery';
import { resolveRequestUsageSource } from '@server/utils/resolveRequestUsageSource';

// The stored key type each vendor needs. Resolved per-user first, then falling
// back to the admin-configured key (getEffectiveApiKey), so the feature works
// out of the box on platforms that provide a shared provider key.
const PROVIDER_API_KEY_TYPE: Record<MusicGenerationVendor, ApiKeyType> = {
  elevenlabs: ApiKeyType.elevenlabs,
};

// Each vendor's output-format check. Run before the reservation: an unmapped codec would be generated and
// billed, then could be neither labelled nor saved.
const SUPPORTS_OUTPUT_FORMAT: Record<MusicGenerationVendor, (format: string) => boolean> = {
  elevenlabs: isSupportedElevenLabsFormat,
};

// Provider-agnostic background-music generation. Meters usage: because the cost
// is deterministic (the requested length is forced on the provider, so the
// generated track always matches what we bill), it RESERVES the rounded-up
// charge before calling the provider and settles the exact cost on success / refunds it on failure
// - so a charge can never fail after the audio is produced. Bills the
// organization's shared pool for org-billed API keys and for org-seat members;
// otherwise the user. All billing is gated on the enforceCredits admin setting,
// so self-host / credits-off deployments run free. Scope-gated (AI_GENERATE) so
// an under-scoped API key can't drive paid provider generation, matching
// image/video/sound-effects. Mirrors pages/api/ai/sound-effects.ts.
//
// Auth mode, required scopes, and request validation all come from
// generateMusicContract (the same source of truth that drives the OpenAPI spec);
// `req.validated` is the parsed, typed body.
const handler = nextRouteForContract(generateMusicContract).post(async (req, res) => {
  const { provider, prompt, lengthMs, forceInstrumental, modelId, format, encoding, preview } = req.validated;
  const userId = req.user?.id;

  // Undefined falls back to the vendor's mp3 default, which every vendor supports. An empty string is
  // checked too: the generators keep it (`??`), so it would otherwise fail only after the reservation.
  if (format !== undefined && !SUPPORTS_OUTPUT_FORMAT[provider](format)) {
    throw new UnprocessableEntityError(`The ${provider} provider does not support the '${format}' output format`);
  }

  await (await createModelAdmission(req.user!)).assert(modelId ?? DEFAULT_MUSIC_MODEL_ID);

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

  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['enforceCredits'], skipCache: true }
  );
  const enforceCredits = getSettingsValue('enforceCredits', settings);

  // Cost is deterministic from the request (length-driven), so the same estimate
  // drives the reservation, the settlement, and the usage-event COGS - it's
  // computed regardless of enforceCredits so analytics capture true provider
  // cost even on credits-off / self-host deployments.
  const { requiredCredits, usdCost, billedSeconds } = estimateMusicCredits(provider, { lengthMs });

  const reservation = await reserveRequestCredits({
    req,
    requiredCredits,
    enforceCredits,
    featureLabel: 'music generation',
  });
  const { ownerId: creditOwnerId, ownerType: creditOwnerType } = reservation;

  const sessionId = `music-${userId}-${randomUUID()}`;
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
        feature: 'music_generation',
        provider,
        model: modelId,
        // Matches this call's ledger write (deductCreditsWithOrgSupport).
        source,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        // Billed track length in seconds; the provider generates exactly this
        // length, so units stay consistent with costUsd.
        units: billedSeconds,
        costUsd: costUsdValue,
        creditsCharged,
        status,
      })
      .catch(err => req.logger.warn('Failed to record music-generation usage event', { err }));

  let audio: Buffer;
  let contentType: string;
  try {
    ({ audio, contentType } = await runElevenLabsWithCapacity(
      {
        operation: 'music',
        apiKey,
        db: { adminSettings: adminSettingsRepository, caches: cacheRepository },
        logger: req.logger,
      },
      ({ timeoutMs }) =>
        aiMusicService(provider, apiKey, req.logger, { timeoutMs }).generate(prompt, {
          lengthMs,
          forceInstrumental,
          modelId,
          format,
        })
    ));
  } catch (error) {
    // Log before refunding, so a refund that throws cannot swallow the original failure.
    if (error instanceof ProviderBusyError) {
      req.logger.warn('Music generation deferred: provider at capacity', { provider, reason: error.reason });
      // Refund the reserved credits - a failed generation incurs no provider cost.
      await reservation.refund();
      // Only a 429'd attempt reached the provider; a request that never got a slot made no call to record.
      if (error.reason === 'upstream_rate_limited') recordUsage('error', 0, 0);
      throw providerBusyHttpError(error);
    }
    req.logger.error('Music generation failed', {
      provider,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    await reservation.refund();
    recordUsage('error', 0, 0);
    return res.status(502).json({ error: 'Music generation failed' });
  }

  // The provider generates exactly the billed length, so settle that exact cost; the round-up held at
  // reservation is refunded.
  const creditsCharged = await reservation.settle(usdToCreditsStochastic(usdCost), {
    type: 'music_generation_usage',
    sessionId,
    model: modelId,
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
              generator: 'music',
              provider,
              modelId,
              prompt,
              durationSeconds: lengthMs / 1000,
              request: {
                provider,
                prompt,
                lengthMs,
                ...(forceInstrumental !== undefined && { forceInstrumental }),
                ...(modelId !== undefined && { modelId }),
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
