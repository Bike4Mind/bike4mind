import { creditTransactionRepository, userRepository } from '@bike4mind/database';
import { CreditHolderType } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { ForbiddenError } from '@server/utils/errors';
import { z } from 'zod';

// Manual credit movements only: admin adjustments/grants land here (both are
// generic_*). Usage/purchase/subscription rows are excluded so the trail reads
// as an audit of admin actions, not spend.
const ADJUSTMENT_TYPES = ['generic_add', 'generic_deduct'] as const;

const QuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(90),
});

/** One admin credit adjustment, actor resolved to a display name for the UI. */
export interface IUserCreditAdjustment {
  id: string;
  createdAt: string;
  /** Signed delta: positive for a grant, negative for a deduction. */
  credits: number;
  description?: string;
  reason?: string;
  actorId?: string;
  actorName?: string;
  resultingBalance?: number;
}

const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, { userId?: string; days?: string }>(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const { days } = QuerySchema.parse({ days: req.query.days });

    const transactions = await creditTransactionRepository.findByOwnerWithFilters(userId, CreditHolderType.User, {
      days,
      transactionTypes: [...ADJUSTMENT_TYPES],
    });

    // Resolve each distinct actor once for display.
    const actorIds = [
      ...new Set(
        transactions
          .map(tx => (tx.metadata?.actorId as string | undefined) ?? undefined)
          .filter((id): id is string => !!id)
      ),
    ];
    const actorNames = new Map<string, string>();
    await Promise.all(
      actorIds.map(async id => {
        const actor = await userRepository.findById(id);
        if (actor) {
          actorNames.set(id, actor.name || actor.email || actor.username || id);
        }
      })
    );

    const rows: IUserCreditAdjustment[] = transactions.map(tx => {
      const actorId = tx.metadata?.actorId as string | undefined;
      return {
        id: tx.id,
        createdAt: tx.createdAt.toISOString(),
        credits: tx.credits,
        description: tx.description,
        reason: 'reason' in tx ? (tx.reason as string | undefined) : undefined,
        actorId,
        actorName: actorId ? actorNames.get(actorId) : undefined,
        resultingBalance: tx.metadata?.resultingBalance as number | undefined,
      };
    });

    return res.status(200).json({ rows });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
