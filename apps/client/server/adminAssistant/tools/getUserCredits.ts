import { CreditHolderType } from '@bike4mind/common';
import { creditTransactionRepository } from '@bike4mind/database';
import { z } from 'zod';
import { defineAdminTool } from '../defineAdminTool';
import { resolveAdminUserRef } from '../resolveAdminUserRef';
import { AdminUserRefFields, withExactlyOneUserRef } from '../schemas';

const ADJUSTMENT_TYPES = ['generic_add', 'generic_deduct'] as const;
const PURCHASE_TYPES = ['purchase', 'subscription'] as const;

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
    "Read a user's current credit balance and recent credit adjustments (admin grants and deductions); optionally purchases and subscription grants.",
  input: GetUserCreditsInput,
  run: async ({ userId, email, days, limit, includePurchases }) => {
    const user = await resolveAdminUserRef({ userId, email });
    if (!user) return { ok: false, error: 'not_found', message: 'No user matches that id or email.' };

    const transactions = await creditTransactionRepository.findByOwnerWithFilters(user.id, CreditHolderType.User, {
      days,
      transactionTypes: includePurchases ? [...ADJUSTMENT_TYPES, ...PURCHASE_TYPES] : [...ADJUSTMENT_TYPES],
      limit,
    });

    return {
      ok: true,
      data: {
        balance: user.currentCredits,
        transactions: transactions.map(transaction => ({
          at: transaction.createdAt.toISOString(),
          type: transaction.type,
          amount: transaction.credits,
          ...('reason' in transaction && transaction.reason ? { reason: transaction.reason } : {}),
        })),
      },
    };
  },
});
