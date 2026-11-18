import { z } from 'zod';
import { AccountSegmentSchema } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { organizationRepository, withTransaction } from '@bike4mind/database';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

const bodySchema = z.object({ accountSegment: AccountSegmentSchema });

/**
 * PUT /api/admin/organizations/[id]/segment - needs settings:manage.
 * Sets an org's account segment (`Organization.accountSegment`); customer is the absence of the
 * field, so it is unset rather than stored. Spend explorer splits AI cost by it. The write and its
 * audit entry commit together.
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { PUT: 'settings:manage' } }).put(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const organizationId = req.query.id;
    if (!organizationId) throw new BadRequestError('Organization id is required');

    const parsedBody = bodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new BadRequestError(
        "Invalid request body: expected { accountSegment: 'internal' | 'partner' | 'customer' }"
      );
    }
    const { accountSegment } = parsedBody.data;
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

    await withTransaction(async () => {
      const organization = await organizationRepository.findById(organizationId);
      if (!organization) throw new NotFoundError('Organization not found');

      const before = organization.accountSegment ?? 'customer';
      // Unchanged is a no-op: no write and no audit entry.
      if (before === accountSegment) return;

      await organizationRepository.setAccountSegment(
        organizationId,
        accountSegment === 'customer' ? null : accountSegment
      );

      await recordAdminActionFromRequest(req, {
        action: 'org.segment.changed',
        target: { kind: 'organization', id: organizationId, displayName: organization.name ?? organizationId },
        summary: `set the account segment to ${accountSegment}`,
        reason,
        changes: [{ field: 'accountSegment', before, after: accountSegment }],
      });
    });

    res.status(200).json({ accountSegment });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
