// POST /api/organizations/:id/api-keys/:keyId/revoke
// Disables an org-owned key; it is refused from then on. Owner, current manager or platform admin
// (verifyOrgAccess). `revokedBy` records the admin, not the service account holding the key.
// Revoking an already-disabled key is a no-op: 200, no second audit row.

import { ApiKeyStatus } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { loadOrgOwnedKey } from '@server/organizations/orgApiKeys';
import { endKeyRealtimeConnections } from '@server/utils/adminApiKeyActions';
import { verifyOrgAccess } from '@bike4mind/server-utils/utils/orgAccess';
import { z } from 'zod';

const RevokeOrgApiKeyBodySchema = z.object({ reason: z.string().trim().max(500).optional() }).optional();

const stringParam = (value: unknown): string => (typeof value === 'string' ? value : '');

const handler = baseApi({ auth: 'jwtOnly' }).post(
  asyncHandler<{}, unknown, unknown, { id?: string; keyId?: string }>(async (req, res) => {
    const user = req.user!;
    const org = await verifyOrgAccess(user, stringParam(req.query.id));
    // A bodyless POST without a JSON content type reaches here as ''.
    const reason = parseOrBadRequest(RevokeOrgApiKeyBodySchema, req.body || undefined)?.reason || undefined;
    const { apiKey } = await loadOrgOwnedKey(org.id, stringParam(req.query.keyId));
    if (apiKey.status === ApiKeyStatus.DISABLED) return res.status(200).json({ success: true });

    // The revoke and its strict audit row commit together. A concurrent revoke that landed after the
    // status check above makes this one a no-op too.
    const revoked = await withTransaction(async () => {
      const didRevoke = await userApiKeyRepository.revokeIfNotDisabled(apiKey.id, user.id, reason);
      if (!didRevoke) return false;
      await recordAdminActionFromRequest(req, {
        action: 'org.api_key.revoked',
        actorScope: 'organization',
        target: { kind: 'organization', id: org.id, displayName: org.name },
        summary: `revoked organization API key "${apiKey.name}"`,
        details: { keyId: apiKey.id, keyPrefix: apiKey.keyPrefix, ...(reason ? { reason } : {}) },
      });
      return true;
    });
    if (revoked) await endKeyRealtimeConnections(apiKey.id, req.logger);

    return res.status(200).json({ success: true });
  })
);

export default handler;
