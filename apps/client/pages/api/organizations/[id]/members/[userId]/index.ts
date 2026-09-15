import { organizationService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_SHARE_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';
import { withTransaction, dataLakeRepository, dataLakeAccessGrantRepository } from '@bike4mind/database';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';
import { organizationRepository } from '@bike4mind/database/infra';
import { userRepository } from '@bike4mind/database/auth';
import { groupRepository } from '@bike4mind/database/social';
import { OrganizationEvents, toSafeOrganization } from '@bike4mind/common';
import { logEvent } from '@server/utils/analyticsLog';

// `datalake:share` is required because this route now changes who can reach a data lake: removing a
// member expires their grants on the org's lakes and can mint an owner grant for the billing owner.
// That is exactly what the scope is defined for ("This API key cannot change who can reach a data
// lake"), and a scope-less `baseApi()` is fail-OPEN - any valid key satisfied it. Session callers
// are unaffected: the gate no-ops when there is no `req.apiKeyInfo`.
const handler = baseApi({ requiredScopes: DATA_LAKE_SHARE_SCOPES }).delete(async (req, res) => {
  // Transaction: removing the member from the org, pulling the org's group ids from their
  // user doc, lapsing their data-lake grants on this org's lakes, and dropping them from
  // adminUserIds must all commit together (org-groups #1172). A member left holding live grants
  // because the org write committed is the exact split this transaction exists to prevent.
  const organization = await withTransaction(() =>
    organizationService.revokeAccess(
      req.user,
      { ...(req.query as any) },
      {
        db: {
          organizations: organizationRepository,
          users: userRepository,
          groups: groupRepository,
          dataLakes: dataLakeRepository,
          dataLakeAccessGrants: dataLakeAccessGrantRepository,
          ...lakeConfigAuditDb,
        },
        // Resolved here rather than in the service: whether this removal came from a browser
        // session or an API key is a request fact the service must not have to infer. Without it
        // the lake audit rows record `principalKind: 'user'` and the key id is lost, so a scripted
        // access change is indistinguishable from the admin clicking the button themselves.
        auditPrincipal: lakeConfigAuditPrincipal(req.user, req.apiKeyInfo),
        logger: req.logger,
      }
    )
  );

  await logEvent(
    {
      userId: req.user.id,
      type: OrganizationEvents.REMOVE_ORG_MEMBER,
      metadata: {
        organizationId: organization.id,
        userId: req.query.userId as string,
      },
    },
    { ability: req.ability }
  );

  return res.json(toSafeOrganization(organization, { userId: req.user.id, isAdmin: req.user.isAdmin }));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
