import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userApiKeyService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { resolveApiKeyTrust } from '@server/utils/apiKeyTrust';

export type ApiKeyEligibilityResponse = {
  /**
   * Whether the trust gate lets the caller mint another personal (user-billed) key. Org-billed
   * keys are not gated. The ordinary per-user key cap is not reflected here.
   */
  canCreate: boolean;
  /** Why not, and what would unlock it. Null when canCreate is true. */
  message: string | null;
};

/**
 * GET /api/user-api-keys/eligibility
 *
 * The caller's standing with the API key trust gate, so the key-creation UI can disable itself
 * with the same explanation POST /api/user-api-keys would return as a 403.
 */
const handler = baseApi().get(async (req, res) => {
  const { assessment } = await resolveApiKeyTrust(req.user, req);
  if (assessment.status !== 'untrusted') {
    return res.json({ canCreate: true, message: null } satisfies ApiKeyEligibilityResponse);
  }

  const activePersonalKeys =
    assessment.reason === 'email_unverified'
      ? 0
      : await userApiKeyRepository.countActiveByUserId(req.user.id, 'personal');
  const canCreate = userApiKeyService.untrustedOwnerMayMint(assessment, activePersonalKeys);
  return res.json({
    canCreate,
    message: canCreate ? null : userApiKeyService.describeApiKeyTrustRequirement(assessment),
  } satisfies ApiKeyEligibilityResponse);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
