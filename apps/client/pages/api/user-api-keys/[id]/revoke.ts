import { userApiKeyService } from '@bike4mind/services';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { organizationRepository, realtimeConnectionRepository, withTransaction } from '@bike4mind/database';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { notifyApiKeyOrgRevoke } from '@server/utils/apiKeyRotationNotifier';
import { baseApi } from '@server/middlewares/baseApi';
import { assertNotOrgServiceAccount } from '@server/auth/assertNotOrgServiceAccount';
import { logEventSafe } from '@bike4mind/server-utils/utils/analyticsLog';
import { UserApiKeyEvents } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

const handler = baseApi().post(
  asyncHandler<{}, unknown, { reason?: string }, { id: string }>(async (req, res) => {
    const userId = req.user?.id;
    assertNotOrgServiceAccount(req.user);
    const keyId = req.query.id;
    const { reason } = req.body;

    if (!keyId) throw new BadRequestError('Invalid key ID');

    // An org admin revoking a key they did not mint gets the same strict audit row, committed with the
    // revoke, as the org API keys surface (pages/api/organizations/[id]/api-keys/**).
    const { revoked, org } = await withTransaction(async () => {
      const result = await userApiKeyService.revokeUserApiKey(
        userId,
        { keyId, reason },
        {
          db: {
            userApiKeys: userApiKeyRepository,
            organizations: organizationRepository,
            realtimeConnections: realtimeConnectionRepository,
          },
        }
      );
      if (!result.didRevoke || result.holderUserId === userId || !result.organizationId) {
        return { revoked: result, org: null };
      }
      const billingOrg = await organizationRepository.findById(result.organizationId);
      await recordAdminActionFromRequest(req, {
        action: result.orgOwned ? 'org.api_key.revoked' : 'org.api_key.member_revoked',
        actorScope: 'organization',
        target: {
          kind: 'organization',
          id: result.organizationId,
          displayName: billingOrg?.name ?? result.organizationId,
        },
        summary: `revoked ${result.orgOwned ? 'organization' : "a member's"} API key "${result.name}"`,
        details: {
          keyId: result.id,
          keyPrefix: result.keyPrefix,
          ...(result.orgOwned ? {} : { creatorUserId: result.holderUserId }),
          ...(reason ? { reason } : {}),
        },
      });
      return { revoked: result, org: billingOrg };
    });
    const { name } = revoked;

    await logEventSafe(
      {
        userId,
        type: UserApiKeyEvents.REVOKED,
        metadata: {
          keyId,
          name,
          reason,
        },
      },
      { ability: req.ability },
      req.logger
    );

    if (org && !revoked.orgOwned) await notifyApiKeyOrgRevoke(revoked.holderUserId, name, org.name, req.logger);

    return res.status(200).json({ success: true });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
