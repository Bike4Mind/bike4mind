import { ApiKeyStatus, BadRequestError, NotFoundError, assertCanActOnAdminTarget } from '@bike4mind/common';
import {
  realtimeConnectionRepository,
  userApiKeyRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { authSessionService } from '@bike4mind/services';
import { adminApi } from '@server/middlewares/adminApi';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';

const api = adminApi({ adminPermissions: { POST: 'keys:revoke' }, auth: 'jwtOnly' });
const handler = api.post(async (req, res) => {
  const { id } = req.query;
  if (typeof id !== 'string' || !id) throw new BadRequestError('Invalid API key ID');
  const reason = parseAdminActionReason(req.body?.reason);

  const canonicalKeyId = await withTransaction(async () => {
    const key = await userApiKeyRepository.findById(id);
    if (!key) throw new NotFoundError('API key not found');
    // An orphaned key (owner deleted) has no admin access to protect, so it stays revocable.
    assertCanActOnAdminTarget(req.user, await userRepository.findById(key.userId), 'revoke API keys of');
    if (key.status === ApiKeyStatus.DISABLED) return key.id;

    await userApiKeyRepository.revokeIfNotDisabled(key.id, req.user.id, reason);
    await recordAdminActionFromRequest(req, {
      action: 'user.api_key.revoked',
      target: { kind: 'apiKey', id: key.id, displayName: key.name },
      summary: 'revoked a user API key',
      reason,
      changes: [{ field: 'status', before: key.status, after: ApiKeyStatus.DISABLED }],
      details: { ownerUserId: key.userId },
    });
    return key.id;
  });

  await authSessionService.endRealtimeConnections(
    { apiKeyId: canonicalKeyId },
    { db: { realtimeConnections: realtimeConnectionRepository }, logger: req.logger }
  );
  return res.json({ success: true });
});

export const config = { api: { externalResolver: true } };
export default handler;
