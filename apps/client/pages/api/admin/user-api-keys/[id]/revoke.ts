import { ApiKeyStatus, ConflictError, ForbiddenError } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import {
  auditKeyRef,
  endKeyRealtimeConnections,
  loadApiKeyOrThrow,
  ownerAuditTarget,
  readApiKeyIdParam,
} from '@server/utils/adminApiKeyActions';

/**
 * POST /api/admin/user-api-keys/[id]/revoke  { reason }
 *
 * Admin-only: disables any user's key, stamping the acting admin as `revokedBy` (which is what lets
 * the same admin undo it through /restore). The key is read from the database on every request
 * (apiKeyAuth keeps no key cache), so the revoke bites on the next call; realtime sockets opened with
 * the key are ended too. The revoke and its strict audit row commit together.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(csrfProtection())
  .post(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');
    const keyId = readApiKeyIdParam(req);
    const reason = parseAdminActionReason(req.body?.reason);

    const key = await loadApiKeyOrThrow(keyId);
    if (key.status === ApiKeyStatus.DISABLED) throw new ConflictError('API key is already revoked');

    const adminId = req.user.id;
    const target = await ownerAuditTarget(key.userId);
    await withTransaction(async () => {
      // A concurrent revoke can land after the status check above.
      const revoked = await userApiKeyRepository.revokeIfNotDisabled(key.id, adminId, reason);
      if (!revoked) throw new ConflictError('API key is already revoked');
      await recordAdminActionFromRequest(req, {
        action: 'user.api_key.revoked',
        target,
        summary: `revoked API key ${key.keyPrefix}`,
        reason,
        details: { ...auditKeyRef(key), keyName: key.name },
      });
    });
    await endKeyRealtimeConnections(key.id, req.logger);

    return res.status(200).json({ keyId: key.id, status: ApiKeyStatus.DISABLED });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
