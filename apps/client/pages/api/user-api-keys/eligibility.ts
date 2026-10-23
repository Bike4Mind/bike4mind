import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userApiKeyService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { resolveApiKeyTrust } from '@server/utils/apiKeyTrust';

export type ApiKeyEligibilityResponse = {
  /** Whether the caller may mint another personal (user-billed) key. Org-billed keys are not gated. */
  canCreate: boolean;
  /** Why not, and what would unlock it. Null when canCreate is true. */
  message: string | null;
};

/**
 * GET /api/user-api-keys/eligibility
 *
 * The caller's standing with the API key trust gate, so the key-creation UI can disable itself
 * with the same explanation POST /api/user-api-keys would return as a 403. Mirrors the
 * service's check in userApiKeyService/create.ts.
 */
const handler = baseApi().get(async (req, res) => {
  const { assessment } = await resolveApiKeyTrust(req.user);
  if (assessment.status !== 'untrusted') {
    return res.json({ canCreate: true, message: null } satisfies ApiKeyEligibilityResponse);
  }

  const atCap =
    assessment.reason === 'email_unverified' ||
    (await userApiKeyRepository.countActiveByUserId(req.user.id)) >= assessment.maxActiveKeys;
  return res.json({
    canCreate: !atCap,
    message: atCap ? userApiKeyService.describeApiKeyTrustRequirement(assessment) : null,
  } satisfies ApiKeyEligibilityResponse);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
