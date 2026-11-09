import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiKeyScope } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { propagateBatchAccountRisk } from '@server/billing/linkedAccounts';

/** Matches the accounts the detection-linked card can list (server/admin/detectionLinkedAccounts.ts). */
export const LINKED_SUSPEND_PROPAGATION_MAX = 100;

const RequestSchema = z.object({
  userIds: z
    .array(z.string().regex(/^[0-9a-f]{24}$/i, 'Not a valid id'))
    .min(1)
    .max(LINKED_SUSPEND_PROPAGATION_MAX),
});

/**
 * The linked-account propagation for accounts an admin suspended together (each through
 * PUT /api/users/[id]/update with deferLinkPropagation): one alert for the action, leaving out every
 * account in it. Only accounts that are suspended now count as sources.
 */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] }).post(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
    const { userIds } = RequestSchema.parse(req.body);

    const suspended = (await userRepository.findLinkStatesByIds([...new Set(userIds)]))
      .filter(state => state.isBanned)
      .map(state => state.id)
      .sort();
    if (suspended.length === 0) return res.json({ locked: [], review: [] });

    const digest = createHash('sha256').update(suspended.join(',')).digest('hex').slice(0, 32);
    const result = await propagateBatchAccountRisk(
      {
        sourceUserIds: suspended,
        trigger: 'suspended together by an admin',
        key: `admin-bulk-block:${digest}:${Date.now()}`,
      },
      req.logger
    );
    return res.json(result);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
