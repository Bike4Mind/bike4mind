import type { Obligation } from '@bike4mind/common';
import type { IObligation } from '@bike4mind/database';

/**
 * The wire shape (`ObligationSchema`). The owner and model stay server-side; `destination` is null for a
 * caller that may not read lakes (see obligationLakeScopes.ts).
 */
export function serializeObligation(item: IObligation, opts: { showDestination: boolean }): Obligation {
  return {
    id: item._id.toString(),
    status: item.status,
    document_kind: item.documentKind,
    file_id: item.fileId,
    amount:
      item.amountValue !== null && item.currency !== null ? { value: item.amountValue, currency: item.currency } : null,
    payee: item.payee,
    due_date: item.dueDate ? item.dueDate.toISOString().slice(0, 10) : null,
    destination:
      opts.showDestination && item.destinationLakeId !== null
        ? { lake_id: item.destinationLakeId, name: item.destinationName ?? '' }
        : null,
    summary: item.summary,
    created_at: item.createdAt.toISOString(),
    confirmed_at: item.confirmedAt ? item.confirmedAt.toISOString() : null,
  };
}
