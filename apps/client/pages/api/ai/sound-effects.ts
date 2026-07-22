import {
  ApiKeyScope,
  ApiKeyType,
  CreditHolderType,
  insufficientCreditsError,
  IOrganizationDocument,
  IUserDocument,
  SoundGenerationVendor,
  soundEffectsRequestSchema,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  apiKeyRepository,
  creditTransactionRepository,
  organizationRepository,
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
// credit cost up front (rejecting when the balance is short), then charges after
// a successful generation. Org-billed API keys charge the organization's shared
// pool; all other callers bill the requesting user. All billing is gated on the
// enforceCredits admin setting, so self-host / credits-off deployments run free.
// Scope-gated (AI_GENERATE) so an under-scoped API key can't drive paid provider
// generation, matching the image/video generation endpoints.
const handler = baseApi({ requiredScopes: [ApiKeyScope.AI_GENERATE] }).post(async (req, res) => {
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

  // Cost is deterministic from the request (duration-driven), so the same
  // estimate drives the (optional) balance pre-check, the charge, and the
  // usage-event COGS - it's computed regardless of enforceCredits so analytics
  // capture true provider cost even on credits-off / self-host deployments.
  const { requiredCredits, usdCost, billedSeconds } = estimateSoundCredits(provider, { durationSeconds });

  // Billing owner: org-billed API keys charge the organization's shared pool
  // (invariant: apiKeyInfo.organizationId is set iff billingOwnerType is
  // Organization); every other caller bills the requesting user. The user stays
  // the actor for attribution + per-member usage tracking.
  const billingOrganizationId =
    req.apiKeyInfo?.billingOwnerType === CreditHolderType.Organization ? req.apiKeyInfo.organizationId : undefined;
  const creditOwnerId = billingOrganizationId ?? userId;
  const creditOwnerType = billingOrganizationId ? CreditHolderType.Organization : CreditHolderType.User;

  // Holder docs are resolved under enforceCredits only (both the balance
  // pre-check and the post-generation charge need them); left null on
  // credits-off / self-host deploys, which never bill.
  let billingUser: IUserDocument | null = null;
  let billingOrg: IOrganizationDocument | null = null;

  if (enforceCredits) {
    billingUser = await userRepository.findById(userId);
    if (!billingUser) throw new BadRequestError('User not found');
    if (billingOrganizationId) {
      billingOrg = await organizationRepository.findById(billingOrganizationId);
      if (!billingOrg) throw new BadRequestError('Billing organization not found');
    }

    // Org-billed keys respect the per-member cap before the shared-pool balance,
    // mirroring deductCreditsWithOrgSupport (which re-checks it atomically at charge).
    if (billingOrg?.maxCreditsPerMember != null) {
      const usedCredits = billingOrg.userDetails?.find(member => member.id === userId)?.usedCredits ?? 0;
      if (usedCredits + requiredCredits > billingOrg.maxCreditsPerMember) {
        throw insufficientCreditsError(
          `Your organization member credit limit has been reached for sound generation. Contact your organization administrator.`
        );
      }
    }

    const availableCredits = (billingOrg ?? billingUser).currentCredits ?? 0;
    if (availableCredits < requiredCredits) {
      throw insufficientCreditsError(
        billingOrg
          ? `Your organization does not have enough credits for sound generation. It currently has ${availableCredits} credits and this requires approximately ${requiredCredits}.`
          : `You do not have enough credits for sound generation. You currently have ${availableCredits} credits and this requires approximately ${requiredCredits}.`
      );
    }
  }

  const sessionId = `sound-effects-${userId}-${Date.now()}`;

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
    // A failed generation incurs no provider cost and no charge.
    recordUsage('error', 0, 0);
    return res.status(502).json({ error: 'Sound generation failed' });
  }

  // Charge after a successful generation, gated on enforceCredits. A billing
  // failure is non-fatal (the audio was produced) but logged so a missed charge
  // is visible; the usage event still records the actual creditsCharged.
  let creditsCharged = 0;
  if (enforceCredits && requiredCredits > 0) {
    try {
      // billingUser is guaranteed set here: enforceCredits populated it above.
      await creditService.deductCreditsWithOrgSupport(
        {
          type: 'sound_effects_usage',
          user: billingUser!,
          organization: billingOrg, // null => bills the user's personal pool
          credits: requiredCredits,
          sessionId,
          model: provider,
          source: 'api',
        },
        {
          db: {
            creditTransactions: creditTransactionRepository,
            users: userRepository,
            organizations: organizationRepository,
          },
        }
      );
      creditsCharged = requiredCredits;
    } catch (err) {
      req.logger.error('Sound-effects credit deduction failed - billing may be missed', {
        userId,
        organizationId: billingOrganizationId,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  recordUsage('ok', creditsCharged, usdCost);

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
