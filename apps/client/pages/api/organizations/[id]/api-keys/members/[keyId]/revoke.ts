// POST /api/organizations/:id/api-keys/members/:keyId/revoke
// Disables a member's own key billed to the org; it is refused from then on. Owner, current manager or
// platform admin (manageKeys). The holder is emailed unless they revoked it themselves.
// Revoking an already-disabled key is a no-op: 200, no second audit row, no email.

import { ApiKeyStatus, UserApiKeyEvents } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { logEventSafe } from '@bike4mind/server-utils/utils/analyticsLog';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { loadOrgMemberKey } from '@server/organizations/orgMemberApiKeys';
import { endKeyRealtimeConnections } from '@server/utils/adminApiKeyActions';
import { notifyApiKeyOrgRevoke } from '@server/utils/apiKeyRotationNotifier';
import { verifyOrgPermission } from '@bike4mind/server-utils/utils/orgAccess';
import { z } from 'zod';

const RevokeOrgMemberApiKeyBodySchema = z.object({ reason: z.string().trim().max(500).optional() }).optional();

const stringParam = (value: unknown): string => (typeof value === 'string' ? value : '');

const handler = baseApi({ auth: 'jwtOnly' }).post(
  asyncHandler<{}, unknown, unknown, { id?: string; keyId?: string }>(async (req, res) => {
    const user = req.user!;
    const org = await verifyOrgPermission(user, stringParam(req.query.id), 'manageKeys');
    // A bodyless POST without a JSON content type reaches here as '', as in pages/api/user-api-keys/[id]/revoke.ts.
    const reason = parseOrBadRequest(RevokeOrgMemberApiKeyBodySchema, req.body || undefined)?.reason || undefined;
    const apiKey = await loadOrgMemberKey(org.id, stringParam(req.query.keyId));
    if (apiKey.status === ApiKeyStatus.DISABLED) {
      // Idempotent, and covers a revoke that committed before its teardown ran.
      await endKeyRealtimeConnections(apiKey.id, req.logger);
      return res.status(200).json({ success: true });
    }

    // The revoke and its strict audit row commit together; a concurrent revoke makes this one a no-op.
    const revoked = await withTransaction(async () => {
      const didRevoke = await userApiKeyRepository.revokeIfNotDisabled(apiKey.id, user.id, reason);
      if (!didRevoke) return false;
      await recordAdminActionFromRequest(req, {
        action: 'org.api_key.member_revoked',
        actorScope: 'organization',
        target: { kind: 'organization', id: org.id, displayName: org.name },
        summary: `revoked a member's API key "${apiKey.name}"`,
        details: {
          keyId: apiKey.id,
          keyPrefix: apiKey.keyPrefix,
          creatorUserId: apiKey.userId,
          ...(reason ? { reason } : {}),
        },
      });
      return true;
    });
    await endKeyRealtimeConnections(apiKey.id, req.logger);
    if (!revoked) return res.status(200).json({ success: true });

    await logEventSafe(
      { userId: user.id, type: UserApiKeyEvents.REVOKED, metadata: { keyId: apiKey.id, name: apiKey.name, reason } },
      { ability: req.ability },
      req.logger
    );
    if (apiKey.userId !== user.id) await notifyApiKeyOrgRevoke(apiKey.userId, apiKey.name, org.name, req.logger);

    return res.status(200).json({ success: true });
  })
);

export default handler;
