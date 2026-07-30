import { creditTransactionRepository, userRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { ForbiddenError } from '@server/utils/errors';
import { z } from 'zod';

const QuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  days: z.coerce.number().int().min(1).max(365).optional(),
});

/** One admin credit adjustment across all users, actor + target resolved for the UI. */
export interface IAdminAdjustmentRow {
  id: string;
  createdAt: string;
  /** Signed delta: positive for a grant, negative for a deduction. */
  credits: number;
  description?: string;
  reason?: string;
  actorId?: string;
  actorName?: string;
  targetUserId: string;
  targetUserName?: string;
  resultingBalance?: number;
}

export interface IAdminAdjustmentsResponse {
  rows: IAdminAdjustmentRow[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, { page?: string; limit?: string; days?: string }>(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { page, limit, days } = QuerySchema.parse({
      page: req.query.page,
      limit: req.query.limit,
      days: req.query.days,
    });

    const { data, total } = await creditTransactionRepository.queryAdminAdjustmentsPage({
      days,
      limit,
      skip: (page - 1) * limit,
    });

    // Resolve each distinct user (actor + target) once for display.
    const userIds = [
      ...new Set(
        data.flatMap(tx => [tx.ownerId, tx.metadata?.actorId as string | undefined]).filter((id): id is string => !!id)
      ),
    ];
    const names = new Map<string, string>();
    await Promise.all(
      userIds.map(async id => {
        const u = await userRepository.findById(id);
        if (u) {
          names.set(id, u.name || u.email || u.username || id);
        }
      })
    );

    const rows: IAdminAdjustmentRow[] = data.map(tx => {
      const actorId = tx.metadata?.actorId as string | undefined;
      return {
        id: tx.id,
        createdAt: tx.createdAt.toISOString(),
        credits: tx.credits,
        description: tx.description,
        reason: 'reason' in tx ? (tx.reason as string | undefined) : undefined,
        actorId,
        actorName: actorId ? names.get(actorId) : undefined,
        targetUserId: tx.ownerId,
        targetUserName: names.get(tx.ownerId),
        resultingBalance: tx.metadata?.resultingBalance as number | undefined,
      };
    });

    return res.status(200).json({
      rows,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    } satisfies IAdminAdjustmentsResponse);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
