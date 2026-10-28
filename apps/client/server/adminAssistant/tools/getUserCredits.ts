import { CreditHolderType } from '@bike4mind/common';
import { creditTransactionRepository } from '@bike4mind/database';
import { z } from 'zod';
import { buildActorDirectory } from '../../utils/userActivity';
import { defineAdminTool } from '../defineAdminTool';
import { resolveAdminUserRef } from '../resolveAdminUserRef';
import { AdminUserRefFields, withExactlyOneUserRef } from '../schemas';

const ADJUSTMENT_TYPES = ['generic_add', 'generic_deduct'] as const;
const PURCHASE_TYPES = ['purchase', 'subscription'] as const;

const ADMIN_ADJUSTMENT_REASON = 'admin_adjustment';

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

const GetUserCreditsInput = withExactlyOneUserRef(
  AdminUserRefFields.extend({
    days: z.number().int().min(1).max(90).default(30).describe('How many days back to look (1-90).'),
    limit: z.number().int().min(1).max(50).default(20).describe('Maximum transactions to return (1-50).'),
    includePurchases: z
      .boolean()
      .default(false)
      .describe('Also include purchases and subscription grants, not just adjustments.'),
  })
);

export const getUserCreditsTool = defineAdminTool({
  name: 'admin_get_user_credits',
  description:
    "Read a user's current credit balance and recent generic credit additions and deductions, each with its reason code (system adjustments such as clawbacks, expiry and refunds are included; reason admin_adjustment marks an admin's manual change, with the admin's note and name); optionally purchases and subscription grants.",
  input: GetUserCreditsInput,
  run: async ({ userId, email, days, limit, includePurchases }) => {
    const user = await resolveAdminUserRef({ userId, email });
    if (!user) return { ok: false, error: 'not_found', message: 'No user matches that id or email.' };

    const fetched = await creditTransactionRepository.findByOwnerWithFilters(user.id, CreditHolderType.User, {
      days,
      transactionTypes: includePurchases ? [...ADJUSTMENT_TYPES, ...PURCHASE_TYPES] : [...ADJUSTMENT_TYPES],
      limit: limit + 1,
    });
    const transactions = fetched.slice(0, limit);

    const isAdminAdjustment = (transaction: (typeof transactions)[number]) =>
      'reason' in transaction && transaction.reason === ADMIN_ADJUSTMENT_REASON;
    const actorIdOf = (transaction: (typeof transactions)[number]) =>
      isAdminAdjustment(transaction) ? readString(transaction.metadata?.actorId) : undefined;
    const directory = await buildActorDirectory(
      transactions.map(actorIdOf).filter((id): id is string => id !== undefined)
    );

    return {
      ok: true,
      data: {
        balance: user.currentCredits,
        truncated: fetched.length > limit,
        transactions: transactions.map(transaction => {
          const adminAdjustment = isAdminAdjustment(transaction);
          const actorId = actorIdOf(transaction);
          const note = adminAdjustment ? readString(transaction.metadata?.note) : undefined;
          return {
            at: transaction.createdAt.toISOString(),
            type: transaction.type,
            amount: transaction.credits,
            ...('reason' in transaction && transaction.reason ? { reason: transaction.reason } : {}),
            ...(note ? { note } : {}),
            ...(adminAdjustment
              ? { actorName: actorId ? (directory.get(actorId)?.name ?? 'Unknown admin') : 'Unknown admin' }
              : {}),
          };
        }),
      },
    };
  },
});
