import {
  adminUsageReceiptQuerySchema,
  adminUsageReceiptSchema,
  BadRequestError,
  CREDITS_PAGE_READ,
  NotFoundError,
} from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { loadUsageReceipt } from '@server/utils/adminUsageReceipt';
import { respond } from '@server/utils/respond';

/**
 * GET /api/admin/users/[userId]/usage-receipt?requestId=&at=
 *
 * A content-free receipt for one charged request: model, source, tokens, credits (cost, charged,
 * written off), the limits it ran under, tool calls by name and attachment totals. The response goes
 * through adminUsageReceiptSchema, which carries no content fields, so none can leak.
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: CREDITS_PAGE_READ } }).get(
  asyncHandler(async (req, res) => {
    const { userId, requestId, at } = req.query as Record<string, string | string[] | undefined>;
    if (typeof userId !== 'string' || !userId) throw new BadRequestError('Invalid user ID');
    const query = adminUsageReceiptQuerySchema.safeParse({ requestId, at });
    if (!query.success) throw new BadRequestError(query.error.issues[0]?.message ?? 'Invalid query');

    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError('User not found');

    const receipt = await loadUsageReceipt(user.id, query.data.requestId, new Date(query.data.at));
    return respond(res, adminUsageReceiptSchema, receipt);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
