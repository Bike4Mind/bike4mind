import { userApiKeyService } from '@bike4mind/services';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { organizationRepository, withTransaction } from '@bike4mind/database';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { endKeyRealtimeConnections } from '@server/utils/adminApiKeyActions';
import { notifyApiKeyOrgRevoke } from '@server/utils/apiKeyRotationNotifier';
import { baseApi } from '@server/middlewares/baseApi';
import { assertNotOrgServiceAccount } from '@server/auth/assertNotOrgServiceAccount';
import { logEventSafe } from '@bike4mind/server-utils/utils/analyticsLog';
import { UserApiKeyEvents } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError, parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { z } from 'zod';

// Same bound as the org member-key revoke route, since the reason lands in the same strict audit row.
const RevokeUserApiKeyBodySchema = z.object({ reason: z.string().trim().max(500).optional() }).optional();

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const userId = req.user?.id;
    assertNotOrgServiceAccount(req.user);
    const keyId = req.query.id;
    if (!keyId) throw new BadRequestError('Invalid key ID');
    // A bodyless POST without a JSON content type (an API-key client) reaches here as ''.
    const reason = parseOrBadRequest(RevokeUserApiKeyBodySchema, req.body || undefined)?.reason || undefined;

    // An org admin revoking a member's key they did not mint gets the same strict audit row, committed with
    // the revoke, as pages/api/organizations/[id]/api-keys/members/[keyId]/revoke.ts. Realtime teardown
    // is not passed in: its writes never join the transaction, so it runs after commit instead.
    const { revoked, orgName } = await withTransaction(async () => {
      const result = await userApiKeyService.revokeUserApiKey(
        userId,
        { keyId, reason },
        { db: { userApiKeys: userApiKeyRepository, organizations: organizationRepository } }
      );
      if (!result.didRevoke || result.holderUserId === userId || !result.organizationId) {
        return { revoked: result, orgName: null };
      }
      const billingOrg = await organizationRepository.findById(result.organizationId);
      await recordAdminActionFromRequest(req, {
        action: 'org.api_key.member_revoked',
        actorScope: 'organization',
        target: {
          kind: 'organization',
          id: result.organizationId,
          displayName: billingOrg?.name ?? result.organizationId,
        },
        summary: `revoked a member's API key "${result.name}"`,
        details: {
          keyId: result.id,
          keyPrefix: result.keyPrefix,
          creatorUserId: result.holderUserId,
          ...(reason ? { reason } : {}),
        },
      });
      return { revoked: result, orgName: billingOrg?.name ?? 'your organization' };
    });
    const { name } = revoked;

    // Teardown runs on a repeat revoke too: it is idempotent and covers a revoke that committed before tearing down.
    await endKeyRealtimeConnections(revoked.id, req.logger);
    if (revoked.didRevoke) {
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
    }

    if (orgName) await notifyApiKeyOrgRevoke(revoked.holderUserId, name, orgName, req.logger);

    return res.status(200).json({ success: true });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
