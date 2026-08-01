import { creditTransactionRepository, userRepository } from '@bike4mind/database';
import { CreditHolderType, type CreditTransactionType } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { ForbiddenError } from '@server/utils/errors';
import { z } from 'zod';

// Default view: manual credit movements only (admin adjustments/grants, both
// generic_*), so the trail reads as an audit of admin actions, not spend.
// Support can opt in to purchase/subscription rows via ?types= to verify a
// user's "did my payment go through?" claim. Usage rows stay excluded: they
// have their own analytics views and would drown the ledger.
const ADJUSTMENT_TYPES = ['generic_add', 'generic_deduct'] as const;
// `satisfies` pins every literal to the canonical union, so a union rename fails
// here with a clear error instead of at the repository call site.
const LEDGER_TYPES = [
  ...ADJUSTMENT_TYPES,
  'purchase',
  'subscription',
] as const satisfies readonly CreditTransactionType[];

const QuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(90),
  // Comma-separated opt-in list; absent OR whitespace-only keeps the
  // adjustments-only default (so `?types=` and `?types=%20` behave alike).
  // Trimmed so a hand-typed "purchase, subscription" validates.
  types: z
    .string()
    .optional()
    .transform(v => (v?.trim() ? v.split(',').map(s => s.trim()) : [...ADJUSTMENT_TYPES]))
    .pipe(z.array(z.enum(LEDGER_TYPES)).min(1)),
});

/** One ledger row, actor resolved to a display name for the UI. */
export interface IUserCreditAdjustment {
  id: string;
  /** Which ledger row this is; the default view only returns generic_*. */
  type: (typeof LEDGER_TYPES)[number];
  createdAt: string;
  /** Signed delta: positive for a grant, negative for a deduction. */
  credits: number;
  description?: string;
  reason?: string;
  actorId?: string;
  actorName?: string;
  resultingBalance?: number;
  /** Purchase rows only. */
  status?: string;
  /** Purchase rows, and subscription rows when Stripe-linked. */
  stripePaymentIntentId?: string;
  /** Purchase rows only: money paid, as recorded on the transaction. */
  amount?: number;
}

const handler = baseApi().get(
  // `userId` is always present - it is the `[userId]` route segment.
  asyncHandler<{}, unknown, unknown, { userId: string; days?: string; types?: string }>(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const userId = req.query.userId;
    const { days, types } = QuerySchema.parse({ days: req.query.days, types: req.query.types });

    const transactions = await creditTransactionRepository.findByOwnerWithFilters(userId, CreditHolderType.User, {
      days,
      transactionTypes: types,
      // Defensive cap: today's allowlisted types are low-frequency, but this
      // view has no pagination, so bound the query in case a high-volume type
      // ever joins LEDGER_TYPES.
      limit: 500,
    });

    // Resolve each distinct actor once for display.
    const actorIds = [
      ...new Set(transactions.map(tx => tx.metadata?.actorId as string | undefined).filter((id): id is string => !!id)),
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
        type: tx.type as IUserCreditAdjustment['type'],
        createdAt: tx.createdAt.toISOString(),
        credits: tx.credits,
        description: tx.description,
        reason: 'reason' in tx ? (tx.reason as string | undefined) : undefined,
        actorId,
        actorName: actorId ? actorNames.get(actorId) : undefined,
        resultingBalance: tx.metadata?.resultingBalance as number | undefined,
        status: 'status' in tx ? (tx.status as string | undefined) : undefined,
        stripePaymentIntentId:
          'stripePaymentIntentId' in tx ? (tx.stripePaymentIntentId as string | undefined) : undefined,
        amount: 'amount' in tx ? (tx.amount as number | undefined) : undefined,
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
