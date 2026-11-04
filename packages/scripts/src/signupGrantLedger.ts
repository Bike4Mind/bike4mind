import { CreditTransaction } from '@bike4mind/database';

export const LEDGER_BATCH_SIZE = 500;

export interface ReceivedCredits {
  /** Every signup-grant ledger row: the tranche, unlock payouts and the daily drip. */
  received: number;
  /** Only the daily drip payouts, the part the drip cap counts. */
  dripped: number;
}

const GRANT_ID_PREFIXES = ['verify-grant', 'otc-register-grant', 'unlock-grant'] as const;

/**
 * How one ledger row counts for `userId`, from the transaction ids the grant service writes
 * (stagedSignupGrant.ts, freeCredits.ts). Rows for rewards, purchases and subscriptions use other ids
 * and are never counted.
 */
export function classifyGrantTransaction(transactionId: string, userId: string): 'drip' | 'grant' | null {
  if (transactionId.startsWith(`unlock-grant:activity:${userId}:`)) return 'drip';
  if (
    transactionId === `verify-grant:${userId}` ||
    transactionId === `otc-register-grant:${userId}` ||
    transactionId === `unlock-grant:${userId}` ||
    transactionId.startsWith(`unlock-grant:${userId}:`)
  ) {
    return 'grant';
  }
  return null;
}

/** Credits actually received per user, summed from the ledger rather than read off `currentCredits`. */
export async function readReceivedCredits(userIds: string[]): Promise<Map<string, ReceivedCredits>> {
  const totals = new Map<string, ReceivedCredits>();
  for (const id of userIds) totals.set(id, { received: 0, dripped: 0 });
  const idPattern = new RegExp(`^(${GRANT_ID_PREFIXES.join('|')}):`);

  for (let offset = 0; offset < userIds.length; offset += LEDGER_BATCH_SIZE) {
    const batch = userIds.slice(offset, offset + LEDGER_BATCH_SIZE);
    const rows = CreditTransaction.find(
      { ownerId: { $in: batch }, ownerType: 'User', type: 'generic_add', transactionId: idPattern },
      { ownerId: 1, transactionId: 1, credits: 1, _id: 0 }
    )
      .read('secondaryPreferred')
      .lean<{ ownerId: string; transactionId?: string; credits: number }[]>()
      .cursor({ batchSize: LEDGER_BATCH_SIZE });

    for await (const row of rows) {
      const total = totals.get(row.ownerId);
      const kind = row.transactionId ? classifyGrantTransaction(row.transactionId, row.ownerId) : null;
      if (!total || !kind || !Number.isFinite(row.credits)) continue;
      total.received += row.credits;
      if (kind === 'drip') total.dripped += row.credits;
    }
  }
  return totals;
}
