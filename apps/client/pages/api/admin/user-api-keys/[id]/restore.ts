import { ADMIN_API_KEY_RESTORE_WINDOW_MINUTES, ApiKeyStatus, ConflictError, ForbiddenError } from '@bike4mind/common';
import { userRepository, withTransaction } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { auditKeyRef, loadApiKeyOrThrow, ownerAuditTarget, readApiKeyIdParam } from '@server/utils/adminApiKeyActions';

/**
 * POST /api/admin/user-api-keys/[id]/restore  { reason }
 *
 * Backs the Undo of an admin revoke. Allowed only for the admin who revoked the key, within
 * ADMIN_API_KEY_RESTORE_WINDOW_MINUTES, and while the key has not expired. The same conditions ride
 * the write itself, so two concurrent restores cannot both succeed. The subscription gate is not
 * re-run: restoring returns the user to where they were. A blocked owner is refused, because a block
 * deactivates keys and lifting it must not bring any back (see userService/adminUpdate.ts).
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(csrfProtection())
  .post(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');
    const keyId = readApiKeyIdParam(req);
    const reason = parseAdminActionReason(req.body?.reason);
    const adminId = req.user.id;

    const key = await loadApiKeyOrThrow(keyId);
    if (key.status !== ApiKeyStatus.DISABLED) throw new ConflictError('API key is not revoked');
    if (key.revokedBy !== adminId) {
      throw new ConflictError('Only the admin who revoked this key can restore it');
    }

    const now = Date.now();
    const revokedSince = new Date(now - ADMIN_API_KEY_RESTORE_WINDOW_MINUTES * 60_000);
    if (!key.revokedAt || key.revokedAt < revokedSince) {
      throw new ConflictError(
        `The ${ADMIN_API_KEY_RESTORE_WINDOW_MINUTES}-minute window to undo this revoke has passed`
      );
    }
    if (key.expiresAt && key.expiresAt.getTime() <= now) {
      throw new ConflictError('API key has expired and cannot be restored');
    }

    const owner = await userRepository.findById(key.userId);
    if (owner && userService.accountBlockReasons(owner).length > 0) {
      throw new ConflictError('The key owner is blocked, so this key cannot be restored');
    }

    const target = await ownerAuditTarget(key.userId);
    await withTransaction(async () => {
      const restored = await userApiKeyRepository.restoreRevoked(key.id, adminId, revokedSince);
      if (!restored) throw new ConflictError('API key can no longer be restored');
      await recordAdminActionFromRequest(req, {
        action: 'user.api_key.restored',
        target,
        summary: `restored API key ${key.keyPrefix}`,
        reason,
        details: { ...auditKeyRef(key), keyName: key.name },
      });
    });

    return res.status(200).json({ keyId: key.id, status: ApiKeyStatus.ACTIVE });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
