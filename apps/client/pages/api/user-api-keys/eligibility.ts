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
   * Administered orgs whose org-billed keys the access switch refuses. Org-billed keys skip trust
   * but not the switch; empty whenever the switch admits the caller themselves (which implies it
   * admits org-billed keys).
   */
  refusedOrgIds: string[];
};

/** Ids of the orgs the user administers whose org-billed keys the access switch refuses. */
async function orgsRefusedBySwitch(user: ApiKeyAccessUser, req: ActiveSubscriptionsRequest): Promise<string[]> {
  const organizationIds = await organizationRepository.findIdsAdministeredBy(user.id);
  const allowed = await Promise.all(
    organizationIds.map(organizationId =>
      isApiKeyAccessAllowed(user, { billingOwnerType: CreditHolderType.Organization, organizationId }, req)
    )
  );
  return organizationIds.filter((_, i) => !allowed[i]);
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
      refusedOrgIds: await orgsRefusedBySwitch(req.user, req),
    } satisfies ApiKeyEligibilityResponse);
  }

  const { assessment } = await resolveApiKeyTrust(req.user, req);
  if (assessment.status !== 'untrusted') {
    return res.json({ canCreate: true, message: null, refusedOrgIds: [] } satisfies ApiKeyEligibilityResponse);
  }

  const activePersonalKeys =
    assessment.reason === 'email_unverified'
      ? 0
      : await userApiKeyRepository.countActiveByUserId(req.user.id, 'personal');
  const canCreate = userApiKeyService.untrustedOwnerMayMint(assessment, activePersonalKeys);
  return res.json({
    canCreate,
    message: canCreate ? null : userApiKeyService.describeApiKeyTrustRequirement(assessment),
    refusedOrgIds: [],
  } satisfies ApiKeyEligibilityResponse);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
