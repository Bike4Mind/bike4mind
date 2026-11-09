import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiKeyScope } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
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
 *
 * Gated on users:moderate, the permission the users-list bulk suspend takes (usersBulk/approvalGate.ts):
 * this completes a suspend the same admin just made.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: 'users:moderate' },
}).post(
  asyncHandler(async (req, res) => {
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
    // Each suspend was audited by its own update; this row records what the action did to the
    // accounts linked to them, which no other entry names.
    await recordAdminActionFromRequest(req, {
      action: 'user.linked_accounts.propagated',
      target: { kind: 'system', id: 'linked-suspend-propagation', displayName: 'Linked-account propagation' },
      summary: `propagated ${suspended.length} suspension(s): ${result.locked.length} linked account(s) locked, ${result.review.length} flagged for review`,
      details: { sourceUserIds: suspended, locked: result.locked, review: result.review },
    });
    return res.json(result);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
