/**
 * GET /api/v1/credits/transactions - the caller's personal credit ledger, newest first.
 *
 * The subject is strictly `req.user`: no owner id is read from the query, so a credential only ever
 * sees its own ledger. Distinct from the SPA's GET /api/credits/transactions, which is unpaginated.
 */

import {
  CREDIT_ADD_TRANSACTION_TYPES,
  CREDIT_DEDUCT_TRANSACTION_TYPES,
  CreditHolderType,
  listCreditTransactionsContract,
  type PublicCreditTransaction,
  type ICreditTransactionDocument,
} from '@bike4mind/common';
import { creditTransactionRepository } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { decodeTimeIdCursor, encodeTimeIdCursor } from '@server/utils/cursorPagination';

const CURSOR_SCOPE = 'v1.credit-transactions';

const TYPES_BY_DIRECTION = {
  added: CREDIT_ADD_TRANSACTION_TYPES,
  deducted: CREDIT_DEDUCT_TRANSACTION_TYPES,
  all: undefined,
} as const;

/**
 * Allowlist onto the public shape: ownerId, metadata and the payment-processor ids stay private. The sign
 * comes from the type, because writers disagree on the sign of a stored deduct row.
 */
function toPublicTransaction(tx: ICreditTransactionDocument): PublicCreditTransaction {
  const magnitude = Math.abs(tx.credits);
  return {
    id: tx.id,
    type: tx.type,
    credits: CREDIT_ADD_TRANSACTION_TYPES.includes(tx.type) ? magnitude : -magnitude,
    description: tx.description,
    source: tx.source,
    createdAt: tx.createdAt,
  };
}

const handler = nextRouteForContract(listCreditTransactionsContract, {
  exemptReadsFromDailyRateLimit: true,
}).get(async (req, res) => {
  const { limit, cursor, days, type } = req.validatedQuery;
  const after = cursor === undefined ? undefined : decodeTimeIdCursor(cursor, CURSOR_SCOPE);

  const createdFrom = new Date();
  createdFrom.setDate(createdFrom.getDate() - days);

  // One extra row tells whether another page exists without a count query.
  const rows = await creditTransactionRepository.findLedgerPage(req.user.id, CreditHolderType.User, {
    types: TYPES_BY_DIRECTION[type] && [...TYPES_BY_DIRECTION[type]],
    createdFrom,
    after: after && { createdAt: after.at, id: after.id },
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit ? encodeTimeIdCursor(CURSOR_SCOPE, { at: last.createdAt, id: last.id }) : null;

  // User-specific payload behind CloudFront - never cacheable, anywhere.
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ data: page.map(toPublicTransaction), next_cursor: nextCursor });
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
