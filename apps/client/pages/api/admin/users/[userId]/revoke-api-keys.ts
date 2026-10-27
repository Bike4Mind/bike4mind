import {
  adminRevokeAllApiKeysResponseSchema,
  ApiKeyStatus,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '@bike4mind/common';
import { userRepository, withTransaction } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { auditKeyRef, endKeyRealtimeConnections } from '@server/utils/adminApiKeyActions';
import { respond } from '@server/utils/respond';

/**
 * POST /api/admin/users/[userId]/revoke-api-keys  { reason }
 *
 * Admin-only: revokes every key the user owns that is not already disabled, stamping the acting
 * admin as `revokedBy`. The keys and ONE strict audit row (listing each key id and prefix) commit
 * together. A user with nothing left to revoke gets an empty list and no audit row, since nothing
 * changed.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(csrfProtection())
  .post(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');
    const { userId } = req.query as { userId?: string | string[] };
    if (typeof userId !== 'string' || !userId) throw new BadRequestError('Invalid user ID');
    const reason = parseAdminActionReason(req.body?.reason);

    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError('User not found');

    const keys = await userApiKeyRepository.findByUserId(user.id);
    const revocable = keys.filter(key => key.status !== ApiKeyStatus.DISABLED);
    if (revocable.length === 0) {
      return respond(res, adminRevokeAllApiKeysResponseSchema, { revokedKeyIds: [] });
    }

    const adminId = req.user.id;
    await withTransaction(async () => {
      for (const key of revocable) {
        await userApiKeyRepository.revokeIfNotDisabled(key.id, adminId, reason);
      }
      await recordAdminActionFromRequest(req, {
        action: 'user.api_keys.revoked_all',
        target: { kind: 'user', id: user.id, displayName: user.email ?? user.username ?? user.id },
        summary: `revoked ${revocable.length} API key${revocable.length === 1 ? '' : 's'}`,
        reason,
        details: { count: revocable.length, keys: revocable.map(auditKeyRef) },
      });
    });
    await Promise.all(revocable.map(key => endKeyRealtimeConnections(key.id, req.logger)));

    return respond(res, adminRevokeAllApiKeysResponseSchema, { revokedKeyIds: revocable.map(key => key.id) });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
