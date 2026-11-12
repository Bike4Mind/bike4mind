import { z } from 'zod';
import { organizationService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_SHARE_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';
import {
  withTransaction,
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  agentRepository,
  artifactRepository,
  fabFileRepository,
  projectRepository,
  sessionRepository,
} from '@bike4mind/database';
import { lakeConfigAuditDb } from '@bike4mind/server-utils/dataLakes/lakeConfigAuditDb';
import { organizationRepository } from '@bike4mind/database/infra';
import { userApiKeyRepository, userRepository } from '@bike4mind/database/auth';
import { recordAdminActionFromRequest, userAuditTarget } from '@bike4mind/server-utils/utils/adminAudit';
import { groupRepository } from '@bike4mind/database/social';
import { OrganizationEvents, toSafeOrganization } from '@bike4mind/common';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import { reportAndNotifyKeptPersonalLakeShares } from '@server/utils/keptPersonalLakeSharesNotifier';
import { BadRequestError, ForbiddenError } from '@bike4mind/server-utils/utils/errors';

const BodySchema = z.object({ reassignTo: z.string().min(1).optional() }).strict();

// `datalake:share` is required because this route now changes who can reach a data lake: removing a
// member expires their grants on the org's lakes and can mint an owner grant for the billing owner.
// That is exactly what the scope is defined for ("This API key cannot change who can reach a data
// lake"), and a scope-less `baseApi()` is fail-OPEN - any valid key satisfied it. Session callers
// are unaffected: the gate no-ops when there is no `req.apiKeyInfo`.
const handler = baseApi({ requiredScopes: DATA_LAKE_SHARE_SCOPES }).delete(async (req, res) => {
  // Transaction: removing the member from the org, pulling the org's group ids from their
  // user doc, lapsing their data-lake grants on this org's lakes, and dropping them from
  // adminUserIds must all commit together (org-groups #1172). A member left holding live grants
  // because the org write committed is the exact split this transaction exists to prevent. The
  // audit row is strict and rides the same transaction, so a removal never commits unrecorded.
  const parsedBody = BodySchema.safeParse(req.body || {});
  if (!parsedBody.success) throw new BadRequestError('Invalid request body');
  const { reassignTo } = parsedBody.data;
  // Moving content is a session-only choice in the offboarding dialog; the API-key surface of this
  // route stays removal-only.
  if (reassignTo && req.apiKeyInfo) {
    throw new ForbiddenError('Content transfer is not available to API keys');
  }
  const removedUserId = req.query.userId as string;

  // The transfer runs first, while the member still passes the membership checks, and shares the
  // transaction with the removal: a failed transfer leaves the member and their content untouched.
  const { organization, revokedOrgBilledApiKeyIds, reassigned } = await withTransaction(async () => {
    const reassigned = reassignTo
      ? await organizationService.reassignMemberContent(
          req.user,
          { id: req.query.id as string, userId: removedUserId, reassignTo },
          {
            db: {
              organizations: organizationRepository,
              groups: groupRepository,
              users: userRepository,
              fabFiles: fabFileRepository,
              artifacts: artifactRepository,
              projects: projectRepository,
              sessions: sessionRepository,
              agents: agentRepository,
            },
          }
        )
      : null;
    const result = await organizationService.revokeAccess(
      req.user,
      { ...(req.query as any) },
      {
        db: {
          organizations: organizationRepository,
          users: userRepository,
          groups: groupRepository,
          dataLakes: dataLakeRepository,
          dataLakeAccessGrants: dataLakeAccessGrantRepository,
          userApiKeys: userApiKeyRepository,
          ...lakeConfigAuditDb,
        },
        // Resolved here rather than in the service: whether this removal came from a browser
        // session or an API key is a request fact the service must not have to infer. Without it
        // the lake audit rows record `principalKind: 'user'` and the key id is lost, so a scripted
        // access change is indistinguishable from the admin clicking the button themselves.
        auditPrincipal: lakeConfigAuditPrincipal(req.user, req.apiKeyInfo),
        logger: req.logger,
      }
    );
    const target = await userAuditTarget(removedUserId);
    await recordAdminActionFromRequest(req, {
      action: 'org.member.removed',
      actorScope: 'organization',
      target,
      organizationId: result.organization.id,
      summary: `removed from organization ${result.organization.name}`,
      details: {
        organizationName: result.organization.name,
        revokedOrgBilledKeys: result.revokedOrgBilledApiKeyIds.length,
      },
    });
    if (reassignTo && reassigned && Object.values(reassigned).some(count => count > 0)) {
      await recordAdminActionFromRequest(req, {
        action: 'org.member.content_reassigned',
        actorScope: 'organization',
        target,
        organizationId: result.organization.id,
        summary: `organization content transferred in ${result.organization.name}`,
        details: { organizationName: result.organization.name, toUserId: reassignTo, counts: reassigned },
      });
    }
    return { ...result, reassigned };
  });

  // After the commit, so a retried transaction cannot mail twice. Shares on personal lakes are not
  // the org's to revoke; their owners are told instead.
  const personalLakeSharesKept = await reportAndNotifyKeptPersonalLakeShares(removedUserId, organization, req.logger);

  await logEvent(
    {
      userId: req.user.id,
      type: OrganizationEvents.REMOVE_ORG_MEMBER,
      metadata: {
        organizationId: organization.id,
        userId: removedUserId,
      },
    },
    { ability: req.ability }
  );

  // Count only: the removing admin cannot see these lakes, so no name or id may reach them.
  return res.json({
    ...toSafeOrganization(organization, { userId: req.user.id, isAdmin: req.user.isAdmin }),
    personalLakeSharesKept,
    revokedOrgBilledKeys: revokedOrgBilledApiKeyIds.length,
    reassigned,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
