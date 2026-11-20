import { z } from 'zod';
import {
  CREDIT_ADD_TRANSACTION_TYPES,
  CREDIT_DEDUCT_TRANSACTION_TYPES,
} from '../types/entities/CreditTransactionTypes';
import { COMPLETION_SOURCES } from '../types/analytics';
import { PaginationQuerySchema, paginatedResponseSchema } from './pagination';

const TRANSACTION_TYPES = [...CREDIT_ADD_TRANSACTION_TYPES, ...CREDIT_DEDUCT_TRANSACTION_TYPES] as [
  (typeof CREDIT_ADD_TRANSACTION_TYPES)[number],
  ...(typeof CREDIT_ADD_TRANSACTION_TYPES)[number][],
];

/** Query for GET /api/v1/credits/transactions: the pagination convention plus a window and a direction filter. */
export const ListCreditTransactionsQuerySchema = PaginationQuerySchema.extend({
  // Bounded: an unbounded value overflows the repository's date arithmetic into an Invalid Date.
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .default(30)
    .describe('Only transactions from the last this-many days. Changing it starts a new listing: drop the cursor.'),
  type: z
    .enum(['all', 'added', 'deducted'])
    .default('all')
    .describe(
      '`added` lists credits received, `deducted` credits spent. Changing it starts a new listing: drop the cursor.'
    ),
});

export type ListCreditTransactionsQuery = z.infer<typeof ListCreditTransactionsQuerySchema>;

/** One ledger row of the caller's personal credit account, without payment-processor ids or internal metadata. */
export const CreditTransactionSchema = z.object({
  id: z.string(),
  type: z
    .enum(TRANSACTION_TYPES)
    .describe('What moved the credits, e.g. `purchase`, `subscription`, `text_generation_usage`.'),
  credits: z
    .number()
    .describe('Signed change to the balance: positive when credits were added, negative when they were spent.'),
  description: z.string().optional(),
  source: z
    .enum(COMPLETION_SOURCES)
    .optional()
    .describe('The surface that spent the credits, on usage rows that record one.'),
  createdAt: z.date(),
});

export type PublicCreditTransaction = z.infer<typeof CreditTransactionSchema>;

export const ListCreditTransactionsResponseSchema = paginatedResponseSchema(CreditTransactionSchema);

export type ListCreditTransactionsResponse = z.infer<typeof ListCreditTransactionsResponseSchema>;
