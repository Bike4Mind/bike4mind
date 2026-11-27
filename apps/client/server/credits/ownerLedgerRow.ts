import type { ICreditTransactionDocument } from '@bike4mind/common';

/** Fields of a ledger row the SPA and desktop usage views read; a new model field stays out until listed. */
const OWNER_LEDGER_ROW_FIELDS = [
  'id',
  'type',
  'credits',
  'description',
  'source',
  'model',
  'reason',
  'amount',
  'status',
  'createdAt',
  'updatedAt',
] as const;

/**
 * Projects a ledger row onto what the owner's own views display. `metadata` is reduced to
 * `modelName`, the only key a client reads; the rest (e.g. referral reward ids) stays server-side.
 */
export function toOwnerLedgerRow(row: ICreditTransactionDocument): Record<string, unknown> {
  // The repository returns hydrated documents: spreading one copies Mongoose internals, not the fields.
  const hydrated = row as { toJSON?: () => Record<string, unknown> };
  const source: Record<string, unknown> = typeof hydrated.toJSON === 'function' ? hydrated.toJSON() : { ...row };
  const projected: Record<string, unknown> = {};
  for (const field of OWNER_LEDGER_ROW_FIELDS) {
    if (source[field] !== undefined) projected[field] = source[field];
  }
  const modelName = row.metadata?.modelName;
  if (typeof modelName === 'string' && modelName) projected.metadata = { modelName };
  return projected;
}
