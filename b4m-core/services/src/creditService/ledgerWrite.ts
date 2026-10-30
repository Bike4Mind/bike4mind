import type { ICreditHolder } from '@bike4mind/common';

/**
 * What a ledger write returns to a caller that links to the row (the admin audit log's
 * `related.creditTransactionId`). `creditTransactionId` is undefined when no row was written,
 * e.g. an idempotent addCredits retry whose row already existed.
 */
export type CreditLedgerWrite = {
  creditHolder: ICreditHolder;
  creditTransactionId: string | undefined;
};
