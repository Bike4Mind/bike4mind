import { z } from 'zod';
import mongoose from 'mongoose';
import { ApiKeyScope, CONFINED_API_KEY_SCOPES, IAdminLegacyApiKeyRow, IAdminLegacyApiKeys } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import {
  getApiKeyLegacyStatus,
  isLegacyWindowOpen,
  LEGACY_API_KEY_WINDOW,
} from '@bike4mind/server-utils/middlewares/apiKeyScopeGate';

const DAY_MS = 24 * 60 * 60 * 1000;

const QuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

/**
 * GET /api/admin/api-keys/legacy - recently used legacy API keys with their owners, so ops can
 * see who still has to move to a scoped key before LEGACY_API_KEY_WINDOW.endsAt. The legacy rule
 * is `getApiKeyLegacyStatus`; the repository query only narrows the candidates.
 */
const handler = adminApi({ adminPermissions: { GET: 'support:read' }, requiredScopes: [ApiKeyScope.ADMIN] }).get(
  asyncHandler<{}, unknown, unknown, { page?: string; limit?: string; days?: string }>(async (req, res) => {
    const { page, limit, days } = QuerySchema.parse({
      page: req.query.page,
      limit: req.query.limit,
      days: req.query.days,
    });
    const window = LEGACY_API_KEY_WINDOW;
    const now = new Date();

    const { keys, total, ownerCount } = isLegacyWindowOpen(now, window)
      ? await userApiKeyRepository.findLegacyCandidatesPage({
          createdBefore: window.cutoff,
          usedSince: new Date(now.getTime() - days * DAY_MS),
          excludeScopes: CONFINED_API_KEY_SCOPES,
          skip: (page - 1) * limit,
          limit,
        })
      : { keys: [], total: 0, ownerCount: 0 };

    const legacyKeys = keys.filter(key => getApiKeyLegacyStatus(key, now, window).legacy);
    const owners = await findOwners(legacyKeys.map(key => key.userId));

    const rows: IAdminLegacyApiKeyRow[] = legacyKeys.map(key => {
      const owner = owners.get(key.userId);
      return {
        keyId: String(key.id),
        name: key.name,
        keyPrefix: key.keyPrefix,
        userId: key.userId,
        ownerEmail: owner?.email,
        ownerName: owner?.name,
        createdAt: new Date(key.createdAt).toISOString(),
        lastUsedAt: new Date(key.lastUsedAt ?? key.createdAt).toISOString(),
      };
    });

    const payload: IAdminLegacyApiKeys = {
      rows,
      page,
      limit,
      total,
      ownerCount,
      usedWithinDays: days,
      cutoff: window.cutoff?.toISOString() ?? null,
      endsAt: window.endsAt?.toISOString() ?? null,
    };
    return res.status(200).json(payload);
  })
);

/** One batched lookup for the page's owners, bounded by the page size. */
async function findOwners(userIds: string[]): Promise<Map<string, { email?: string; name?: string }>> {
  const ids = [...new Set(userIds)].filter(id => mongoose.Types.ObjectId.isValid(id));
  if (ids.length === 0) return new Map();
  const users = await userRepository.find({ _id: { $in: ids } }, { email: 1, name: 1 });
  return new Map(
    users.map(user => [String(user.id), { email: user.email ?? undefined, name: user.name || undefined }])
  );
}

export const config = { api: { externalResolver: true } };
export default handler;
