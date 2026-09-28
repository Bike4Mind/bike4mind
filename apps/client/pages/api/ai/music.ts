import { ApiKeyType, generateMusicContract, MusicGenerationVendor } from '@bike4mind/common';
import { adminSettingsRepository, apiKeyRepository, usageEventRepository } from '@bike4mind/database';
import { apiKeyService, estimateMusicCredits } from '@bike4mind/services';
import { aiMusicService, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { reserveRequestCredits } from '@server/billing/reserveRequestCredits';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { persistGeneratedAudio } from '@server/utils/persistGeneratedAudio';

// The stored key type each vendor needs. Resolved per-user first, then falling
// back to the admin-configured key (getEffectiveApiKey), so the feature works
// out of the box on platforms that provide a shared provider key.
const PROVIDER_API_KEY_TYPE: Record<MusicGenerationVendor, ApiKeyType> = {
  elevenlabs: ApiKeyType.elevenlabs,
};

// Provider-agnostic background-music generation. Meters usage: because the cost
// is deterministic (the requested length is forced on the provider, so the
// generated track always matches what we bill), it RESERVES the exact charge
// before calling the provider and settles it on success / refunds it on failure
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
  const { provider, prompt, lengthMs, forceInstrumental, modelId, format } = req.validated;
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

  const sessionId = `music-${userId}-${Date.now()}`;

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
        // Matches this call's ledger write (deductCreditsWithOrgSupport, source: 'api').
        source: 'api',
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
    const musicService = aiMusicService(provider, apiKey, req.logger);
    ({ audio, contentType } = await musicService.generate(prompt, { lengthMs, forceInstrumental, modelId, format }));
  } catch (error) {
    req.logger.error('Music generation failed', {
      provider,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    // Refund the reserved credits - a failed generation incurs no provider cost.
    await reservation.refund();
    recordUsage('error', 0, 0);
    return res.status(502).json({ error: 'Music generation failed' });
  }

  // Settle the full reservation: the provider generates exactly the billed length.
  const creditsCharged = await reservation.settle(reservation.reservedCredits, {
    type: 'music_generation_usage',
    sessionId,
    model: modelId,
    source: 'api',
  });

  recordUsage('ok', creditsCharged, usdCost);

  // Persist a browsable copy of the generated audio (on by default; opt out via
  // the saveGeneratedAudio preference). Best-effort: a save failure (e.g. over
  // quota) never blocks returning the audio the caller was already charged for.
  if (userId && (req.user?.preferences?.saveGeneratedAudio ?? true)) {
    const save = await persistGeneratedAudio({
      userId,
      audio,
      contentType,
      format,
      source: 'music',
      text: prompt,
      logger: req.logger,
    });
    res.setHeader('X-B4M-Audio-Saved', String(save.saved));
    if (save.saved) {
      res.setHeader('X-B4M-Audio-Fab-File-Id', save.fabFileId);
      res.setHeader('X-B4M-Audio-File-Name', save.fileName);
      // Forward the signed URL minted at creation. Non-image audio gets a working URL
      // immediately (createFabFile), whereas re-resolving it via GET /api/files/:id
      // fails closed until the async moderation scan flips moderationStatus to 'clean'
      // (isImageServeable gates every mime type) - so callers must use this URL, not
      // re-fetch one. Absent only in the rare case createFabFile minted no URL.
      if (save.fileUrl) res.setHeader('X-B4M-Audio-File-Url', save.fileUrl);
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
