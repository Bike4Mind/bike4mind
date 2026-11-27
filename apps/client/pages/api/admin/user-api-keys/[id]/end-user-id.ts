import {
  ApiKeyScope,
  ApiKeyStatus,
  BadRequestError,
  CONFINED_API_KEY_SCOPES,
  ConflictError,
  ForbiddenError,
  isFullAdmin,
  type ApiKeyScopeValue,
} from '@bike4mind/common';
import { withTransaction } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { adminApi } from '@server/middlewares/adminApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import {
  assertCanActOnKeyOwner,
  auditKeyRef,
  loadApiKeyOrThrow,
  ownerAuditTarget,
  readApiKeyIdParam,
} from '@server/utils/adminApiKeyActions';

const confinedScopes: ReadonlySet<ApiKeyScopeValue> = new Set(CONFINED_API_KEY_SCOPES);

/**
 * POST /api/admin/user-api-keys/[id]/end-user-id  { enabled, reason }
 *
 * Grants or withdraws `ai:end-user-id` on an existing key, so a key already serving a product's end
 * users can start sending `end_user_id` without being re-minted. Admin-provisioned like the mint
 * route's other such scopes (users/[userId]/generate-api-key.ts): a full admin only, with a reason.
 * A confined key is refused, since a confined scope must stay its key's only scope.
 */
// The catalogue has no key-provisioning permission (generate-api-key.ts uses the same one); the full-admin check below is what authorizes the grant.
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'keys:revoke' } })
  .use(csrfProtection())
  .post(async (req, res) => {
    if (!isFullAdmin(req.user)) {
      throw new ForbiddenError('Only full administrators can change admin-provisioned API key scopes');
    }
    const keyId = readApiKeyIdParam(req);
    const enabled: unknown = req.body?.enabled;
    if (typeof enabled !== 'boolean') throw new BadRequestError('enabled must be a boolean');
    const reason = parseAdminActionReason(req.body?.reason);

    const key = await loadApiKeyOrThrow(keyId);
    await assertCanActOnKeyOwner(req.user, key.userId, 'change the API key scopes of');
    if (key.status !== ApiKeyStatus.ACTIVE) throw new ConflictError('Only an active API key can be changed');
    if (key.scopes?.some(scope => confinedScopes.has(scope))) {
      throw new ConflictError('A key with a dedicated-flow scope cannot also hold ai:end-user-id');
    }

    if (enabled && !key.scopes?.some(scope => scope === ApiKeyScope.AI_CHAT || scope === ApiKeyScope.AI_GENERATE)) {
      throw new ConflictError('ai:end-user-id only applies to a key that holds ai:chat or ai:generate');
    }

    const target = await ownerAuditTarget(key.userId);
    await withTransaction(async () => {
      await userApiKeyRepository.setScopeHeld(key.id, ApiKeyScope.AI_END_USER_ID, enabled);
      await recordAdminActionFromRequest(req, {
        action: 'user.api_key.end_user_id_updated',
        target,
        summary: `${enabled ? 'granted' : 'withdrew'} ${ApiKeyScope.AI_END_USER_ID} on API key ${key.keyPrefix}`,
        reason,
        details: { ...auditKeyRef(key), keyName: key.name, enabled },
      });
    });

    return res.status(200).json({ keyId: key.id, endUserIdEnabled: enabled });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
