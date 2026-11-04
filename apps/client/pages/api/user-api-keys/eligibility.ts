import { CreditHolderType } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userApiKeyService } from '@bike4mind/services';
import { UnauthorizedError } from '@bike4mind/server-utils/utils/errors';
import type { ActiveSubscriptionsRequest } from '@server/entitlements/activeSubscriptions';
import { baseApi } from '@server/middlewares/baseApi';
import {
  API_KEY_ACCESS_DENIED_MESSAGE,
  isApiKeyAccessAllowed,
  type ApiKeyAccessUser,
} from '@server/utils/apiKeyAccessGate';
import { resolveApiKeyTrust } from '@server/utils/apiKeyTrust';

export type ApiKeyEligibilityResponse = {
  /**
   * Whether the admin access switch and the trust gate both let the caller mint another personal
   * (user-billed) key. The ordinary per-user key cap is not reflected here.
   */
  canCreate: boolean;
  /** Why not, and what would unlock it. Null when canCreate is true. */
  message: string | null;
  /**
   * Whether a key billed to an org the caller administers can still pass. Org-billed keys skip
   * trust but not the access switch, which admits them on the org's plan (or not at all when
   * disabled). Always true when the switch admits the caller themselves.
   */
  orgBillingMayPass: boolean;
};

/** Whether the access switch admits a key billed to at least one org the user administers. */
async function anyAdministeredOrgMayBill(user: ApiKeyAccessUser, req: ActiveSubscriptionsRequest): Promise<boolean> {
  const organizationIds = await organizationRepository.findIdsAdministeredBy(user.id);
  for (const organizationId of organizationIds) {
    const billing = { billingOwnerType: CreditHolderType.Organization, organizationId };
    if (await isApiKeyAccessAllowed(user, billing, req)) return true;
  }
  return false;
}

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
    return res.json({
      canCreate: false,
      message: API_KEY_ACCESS_DENIED_MESSAGE,
      orgBillingMayPass: await anyAdministeredOrgMayBill(req.user, req),
    } satisfies ApiKeyEligibilityResponse);
  }

  const { assessment } = await resolveApiKeyTrust(req.user, req);
  if (assessment.status !== 'untrusted') {
    return res.json({ canCreate: true, message: null, orgBillingMayPass: true } satisfies ApiKeyEligibilityResponse);
  }

  const activePersonalKeys =
    assessment.reason === 'email_unverified'
      ? 0
      : await userApiKeyRepository.countActiveByUserId(req.user.id, 'personal');
  const canCreate = userApiKeyService.untrustedOwnerMayMint(assessment, activePersonalKeys);
  return res.json({
    canCreate,
    message: canCreate ? null : userApiKeyService.describeApiKeyTrustRequirement(assessment),
    orgBillingMayPass: true,
  } satisfies ApiKeyEligibilityResponse);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
