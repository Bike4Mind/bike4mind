import { creditTransactionRepository } from '@bike4mind/database';
import { CreditHolderType, CREDIT_ADD_TRANSACTION_TYPES, CREDIT_DEDUCT_TRANSACTION_TYPES } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';

const CreditTransactionsQuerySchema = z.object({
  /**
   * @description Number of days to get transactions for
   * @default 30
   */
  days: z.number().optional().prefault(30),
  /**
   * @description Type of transactions to get
   * @default 'all'
   * @enum ['all', 'purchase', 'usage']
   */
  type: z.enum(['all', 'added', 'deducted']).optional().prefault('all'),
});

const handler = baseApi().get(async (req, res) => {
  const { user } = req;
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const validation = CreditTransactionsQuerySchema.safeParse({
    days: req.query.days ? parseInt(req.query.days as string) : 30,
    type: req.query.type || 'all',
  });

  if (!validation.success) {
    return res.status(400).json({ error: 'Invalid query parameters', details: validation.error });
  }

  const { days, type } = validation.data;

  // Determine which transaction types to include based on the filter
  let transactionTypes: typeof CREDIT_ADD_TRANSACTION_TYPES | typeof CREDIT_DEDUCT_TRANSACTION_TYPES | undefined;
  if (type === 'added') {
    transactionTypes = CREDIT_ADD_TRANSACTION_TYPES;
  } else if (type === 'deducted') {
    transactionTypes = CREDIT_DEDUCT_TRANSACTION_TYPES;
  }
  // If type is 'all', transactionTypes remains undefined (no filter)

  const transactions = await creditTransactionRepository.findByOwnerWithFilters(user.id, CreditHolderType.User, {
    days,
    transactionTypes,
  });

  return res.status(200).json(transactions);
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
