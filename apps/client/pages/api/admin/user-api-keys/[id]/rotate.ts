import {
  adminRotateApiKeyResponseSchema,
  ApiKeyScope,
  ApiKeyStatus,
  ConflictError,
  ForbiddenError,
  type IUserApiKeyDocument,
} from '@bike4mind/common';
import { organizationRepository, withTransaction } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userApiKeyService } from '@bike4mind/services';
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

// Must stay in sync with the admin mint route (users/[userId]/generate-api-key.ts): these scopes only
// come through their own dedicated flows, so an admin must not obtain a working secret for one here.
const ROTATION_REFUSED_SCOPES: ReadonlySet<string> = new Set([ApiKeyScope.ADMIN, ApiKeyScope.CC_BRIDGE]);

function assertRotatable(key: IUserApiKeyDocument): void {
  if (key.status !== ApiKeyStatus.ACTIVE) throw new ConflictError('Only an active API key can be rotated');
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
    throw new ConflictError('API key has expired and cannot be rotated');
  }
  if (key.scopes?.some(scope => ROTATION_REFUSED_SCOPES.has(scope))) {
    throw new ForbiddenError('Keys with the admin or bridge scope cannot be rotated by an admin');
  }
}

const handler = baseApi({ auth: 'jwtOnly' })
  .use(csrfProtection())
  .post(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');
    const keyId = readApiKeyIdParam(req);
    const reason = parseAdminActionReason(req.body?.reason);

    const key = await loadApiKeyOrThrow(keyId);
    assertRotatable(key);

    const target = await ownerAuditTarget(key.userId);
    const previous = auditKeyRef(key);
    const rotated = await withTransaction(async () => {
      // Re-read under the transaction so a revoke that committed since the check above is refused.
      assertRotatable(await loadApiKeyOrThrow(keyId));
      const result = await userApiKeyService.rotateUserApiKey(
        key.userId,
        { keyId: key.id },
        {
          db: {
            userApiKeys: userApiKeyRepository,
            organizations: organizationRepository,
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
    // After commit, so an aborted rotation leaves the sockets of the still-valid old secret alone.
    await endKeyRealtimeConnections(rotated.id, req.logger);

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
