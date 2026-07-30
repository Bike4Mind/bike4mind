import { organizationService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { withTransaction } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { userRepository } from '@bike4mind/database/auth';
import { groupRepository } from '@bike4mind/database/social';
import { OrganizationEvents, toSafeOrganization } from '@bike4mind/common';
import { logEvent } from '@server/utils/analyticsLog';

const handler = baseApi().delete(async (req, res) => {
  // Transaction: removing the member from the org, pulling the org's group ids from their
  // user doc, and dropping them from adminUserIds must all commit together (org-groups #1172).
  const organization = await withTransaction(() =>
    organizationService.revokeAccess(
      req.user,
      { ...(req.query as any) },
      { db: { organizations: organizationRepository, users: userRepository, groups: groupRepository } }
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
