import type { IDataLakeBatchDocument, IDataLakeBatchRepository } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';

/**
 * Assert the caller owns the batch a request is trying to attach a new file to. `batchId` is
 * client-suppliable on every upload/presign request body, and a batch's id is now load-bearing
 * for background AI-tag-suggestion analysis and apply (both read files straight off it via
 * `findByBatchId`) - so without this, a caller who learns another user's batchId could inject a
 * file that gets sampled into that user's inference prompt (billed to them) or has its tags
 * rewritten by apply. `NotFoundError` either way (missing vs. not-yours) so a probe can't
 * distinguish "doesn't exist" from "exists but isn't mine."
 *
 * Returns the batch it read, so a caller that also needs the document (e.g. the batch-presign door
 * checking the batch's lake against the one the request named) does not read it a second time.
 */
export const assertBatchOwnership = async (
  userId: string,
  batchId: string,
  { db }: { db: { batches: Pick<IDataLakeBatchRepository, 'findById'> } }
): Promise<IDataLakeBatchDocument> => {
  const batch = await db.batches.findById(batchId);
  if (!batch || batch.userId !== userId) {
    throw new NotFoundError('Batch not found');
  }
  return batch;
};
