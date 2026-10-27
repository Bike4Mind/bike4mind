import { adminRotateApiKeyResponseSchema, ApiKeyStatus, ConflictError, ForbiddenError } from '@bike4mind/common';
import { organizationRepository, realtimeConnectionRepository, withTransaction } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userApiKeyService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { auditKeyRef, loadApiKeyOrThrow, ownerAuditTarget, readApiKeyIdParam } from '@server/utils/adminApiKeyActions';
import { respond } from '@server/utils/respond';

/**
 * POST /api/admin/user-api-keys/[id]/rotate  { reason }
 *
 * Admin-only: mints a new secret for an active key on the key's behalf and returns it ONCE. The
 * rotation runs as the key's OWNER, so the key is never re-owned to the admin and billing, org,
 * agent, product and metadata stay exactly as they were. The paid-subscription switch is not applied
 * (an admin action), so a gated owner can hold a rotated key that is still refused at use. The
 * secret never reaches the audit row or the logs.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(csrfProtection())
  .post(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');
    const keyId = readApiKeyIdParam(req);
    const reason = parseAdminActionReason(req.body?.reason);

    const key = await loadApiKeyOrThrow(keyId);
    if (key.status !== ApiKeyStatus.ACTIVE) throw new ConflictError('Only an active API key can be rotated');
    if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
      throw new ConflictError('API key has expired and cannot be rotated');
    }

    const target = await ownerAuditTarget(key.userId);
    const previous = auditKeyRef(key);
    const rotated = await withTransaction(async () => {
      const result = await userApiKeyService.rotateUserApiKey(
        key.userId,
        { keyId: key.id },
        {
          db: {
            userApiKeys: userApiKeyRepository,
            organizations: organizationRepository,
            realtimeConnections: realtimeConnectionRepository,
          },
        }
      );
      await recordAdminActionFromRequest(req, {
        action: 'user.api_key.rotated',
        target,
        summary: `rotated API key ${previous.keyPrefix}`,
        reason,
        details: {
          keyId: previous.keyId,
          keyName: key.name,
          previousKeyPrefix: previous.keyPrefix,
          keyPrefix: result.keyPrefix,
        },
      });
      return result;
    });

    res.setHeader('Cache-Control', 'no-store');
    return respond(res, adminRotateApiKeyResponseSchema, {
      keyId: rotated.id,
      keyPrefix: rotated.keyPrefix,
      secret: rotated.key,
    });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
