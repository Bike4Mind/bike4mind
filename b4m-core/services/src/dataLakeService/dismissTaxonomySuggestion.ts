import type { IDataLakeBatchRepository, IDataLakeRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/common';
import { canManageLake } from './authorizeLakeWrite';

interface DismissTaxonomySuggestionAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById'>;
    batches: Pick<IDataLakeBatchRepository, 'findById' | 'setTaxonomyStatusIfActive'>;
  };
}

/**
 * Clears a `ready`/`failed` taxonomy batch's attention chip without applying or re-analyzing
 * it - the exit path `TAXONOMY_ATTENTION_STATUSES`'s doc comment already anticipated ("failed
 * and dismissible"). Only `taxonomyStatus` moves to `'dismissed'`; the stored
 * `taxonomySuggestions`/`taxonomyError` and every file's tags are left untouched, so this is a
 * one-field, no-file-mutation write - unlike `applyTaxonomySuggestions`, there is nothing to
 * batch-write per file.
 *
 * A dismissed batch is deliberately a dead end, not a resumable one: it's excluded from
 * `TAXONOMY_ATTENTION_STATUSES`, so nothing in the UI ever surfaces a way back to it (no chip,
 * no re-analyze button reachable). That's the intended "I'm done with this" semantics, same as
 * dismissing a notification - distinct from `'applied'`'s dead end (tracked separately, #1268
 * item 13), which is an accidental gap rather than a deliberate one.
 */
export const dismissTaxonomySuggestion = async (
  actor: { userId: string; isAdmin: boolean },
  batchId: string,
  { db }: DismissTaxonomySuggestionAdapters
): Promise<{ success: true }> => {
  const batch = await db.batches.findById(batchId);
  if (!batch) throw new NotFoundError('Batch not found');

  const lake = await db.dataLakes.findById(batch.dataLakeId);
  if (!lake) throw new NotFoundError('Data lake not found');
  if (!canManageLake(lake, actor)) {
    throw new BadRequestError('Only the creator can dismiss tag suggestions for this data lake');
  }

  const claimed = await db.batches.setTaxonomyStatusIfActive(batchId, ['ready', 'failed'], 'dismissed');
  if (!claimed) {
    // Idempotent-friendly: a genuine double-click lands here too, and the batch is already
    // dismissed by the winner - treat that as success rather than an error. Only a real
    // conflict (e.g. a reanalyze raced in and moved it to 'analyzing' first) should fail.
    const current = await db.batches.findById(batchId);
    if (current?.taxonomyStatus === 'dismissed') return { success: true };
    throw new BadRequestError('Tag suggestions are not in a dismissible state for this batch');
  }

  return { success: true };
};
