import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userApiKeyService } from '@bike4mind/services';
import { UnauthorizedError } from '@bike4mind/server-utils/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { API_KEY_ACCESS_DENIED_MESSAGE, isApiKeyAccessAllowed } from '@server/utils/apiKeyAccessGate';
import { resolveApiKeyTrust } from '@server/utils/apiKeyTrust';

export type ApiKeyEligibilityResponse = {
  /**
   * Whether the admin access switch and the trust gate both let the caller mint another personal
   * (user-billed) key. An org-billed key can still pass the switch on the org's plan and is not
   * trust-gated. The ordinary per-user key cap is not reflected here.
   */
  canCreate: boolean;
  /** Why not, and what would unlock it. Null when canCreate is true. */
  message: string | null;
};

/**
 * GET /api/user-api-keys/eligibility
 *
 * The caller's standing with the API key gates, so the key-creation UI can disable itself with the
 * same explanation POST /api/user-api-keys would return as a 403. Checked in the mint's order:
 * the access switch (`apiKeyAccessGate`), then trust.
 */
const handler = baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  if (!(await isApiKeyAccessAllowed(req.user, undefined, req))) {
    return res.json({ canCreate: false, message: API_KEY_ACCESS_DENIED_MESSAGE } satisfies ApiKeyEligibilityResponse);
  }

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
