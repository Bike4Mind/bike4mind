import type { IDataLakeBatchRepository, IDataLakeRepository, IFabFileRepository, TaxonomyTag } from '@bike4mind/common';
import { BadRequestError, NotFoundError, folderTagForFile, tagsForFile } from '@bike4mind/common';
import { canManageLake } from './authorizeLakeWrite';

interface ApplyTaxonomySuggestionsAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById'>;
    batches: Pick<IDataLakeBatchRepository, 'findById' | 'setTaxonomyStatusIfActive'>;
    fabFiles: Pick<IFabFileRepository, 'findByBatchId' | 'bulkUpdateTags'>;
  };
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

/**
 * Applies the reviewed/edited AI-suggested tags to every already-uploaded file in a
 * batch - the post-upload counterpart to the old pre-upload wizard's tagsForFile call at
 * upload time. `acceptedTags` is whatever the review panel produced (the batch's stored
 * `taxonomySuggestions.tags`, minus anything the reviewer deleted, suffixes possibly edited) -
 * this function does not re-validate the review, it just computes and writes the result.
 *
 * Only ADDS category tags on top of what upload already applied (the folder tag): folderTags
 * are subtracted out of tagsForFile's result before merging, so re-running this (e.g. after a
 * re-analyze) can never duplicate a file's folder tag. Existing tags are merged by name,
 * highest strength wins - same rule tagsForFile itself uses for within-file collisions.
 *
 * Every folder-matched file in the batch is touched, not just the sampled subset inference
 * saw: matchingFolders-based category tags were always meant to cover a whole folder, and
 * sampling only ever bounded what got ANALYZED, never what gets APPLIED (mirrors the
 * pre-upload behavior this replaces).
 *
 * No lake-stats recompute: tags don't change lake membership/fileCount/totalSizeBytes.
 *
 * `filesUpdated` can be less than the number of matched files: bulkUpdateTags applies
 * optimistic concurrency per file, so one mutated by something else between the read below and
 * the write (a direct tag edit, a lake-membership pull, another apply) is silently skipped
 * rather than having its concurrent change clobbered by a merge computed from stale data.
 */
export const applyTaxonomySuggestions = async (
  actor: { userId: string; isAdmin: boolean },
  batchId: string,
  acceptedTags: TaxonomyTag[],
  { db, logger }: ApplyTaxonomySuggestionsAdapters
): Promise<{ success: true; filesUpdated: number }> => {
  const batch = await db.batches.findById(batchId);
  if (!batch) throw new NotFoundError('Batch not found');

  const lake = await db.dataLakes.findById(batch.dataLakeId);
  if (!lake) throw new NotFoundError('Data lake not found');
  if (!canManageLake(lake, actor)) {
    throw new BadRequestError('Only the creator can apply tag suggestions for this data lake');
  }

  // Guarded claim: only a batch whose suggestions are 'ready' (and not already being applied
  // by a concurrent request) proceeds. Also blocks re-applying an already-'applied' batch
  // through this endpoint - re-analyze is the intended path for a second pass. Refreshes
  // taxonomyStartedAt so the stuck-job reconciler's clock starts from this transition, not
  // the original queue time - otherwise a batch applied well after analysis finished would
  // look instantly stuck and could get force-failed mid-write.
  const claimed = await db.batches.setTaxonomyStatusIfActive(batchId, ['ready'], 'applying', {
    taxonomyStartedAt: new Date(),
  });
  if (!claimed) {
    throw new BadRequestError('Tag suggestions are not ready to apply for this batch');
  }

  // Cross-check against what was actually suggested: the request schema bounds size/length
  // but does not (and cannot) verify content, and this function otherwise trusts acceptedTags
  // completely. Only a suffix EDIT to a genuinely suggested tag is legitimate - a originalName
  // that never appeared in this batch's real taxonomySuggestions is dropped rather than applied.
  const suggestedNames = new Set((batch.taxonomySuggestions?.tags ?? []).map(t => t.originalName));
  const validTags = acceptedTags.filter(t => suggestedNames.has(t.originalName));

  const taxonomySet = { tags: validTags, fileAssignments: batch.taxonomySuggestions?.fileAssignments ?? [] };

  try {
    const files = await db.fabFiles.findByBatchId(batchId);

    // Compute every file's resolved tag set first (pure, no I/O), then write it in one
    // bulkWrite round trip instead of one findOneAndUpdate per file - a batch can hold
    // thousands of files, and N sequential writes risked exceeding the caller's request
    // timeout mid-apply, stranding the batch in 'applying' with only some files updated.
    const updates = files.flatMap(file => {
      const relativePath = file.relativePath ?? file.fileName;
      const folderTags = folderTagForFile(relativePath, lake.fileTagPrefix);
      const folderTagNames = new Set(folderTags.map(t => t.name));
      // The folder tag is already on the file from upload - keep only the taxonomy-derived
      // portion so re-running this can never duplicate it.
      const newTags = tagsForFile(relativePath, taxonomySet, lake.fileTagPrefix).filter(
        t => !folderTagNames.has(t.name)
      );
      if (newTags.length === 0) return [];

      const existingTags = file.tags ?? [];
      const merged = new Map(existingTags.map(t => [t.name, t.strength]));
      for (const t of newTags) {
        const current = merged.get(t.name);
        if (current === undefined || t.strength > current) merged.set(t.name, t.strength);
      }

      return [
        {
          id: file.id,
          tags: Array.from(merged, ([name, strength]) => ({ name, strength })),
          // The exact snapshot this merge was computed from - bulkUpdateTags uses it for
          // optimistic concurrency, so a file mutated by something else since this read is
          // skipped rather than clobbered by a merge that's now stale.
          expectedTags: existingTags,
        },
      ];
    });

    const filesUpdated = await db.fabFiles.bulkUpdateTags(updates);
    const skipped = updates.length - filesUpdated;
    if (skipped > 0) {
      // Every op in `updates` matched a file that needed new tags - a lower filesUpdated means
      // bulkUpdateTags' optimistic-concurrency check lost the race for `skipped` of them (see
      // its doc comment). Not an error - the concurrent writer's change legitimately wins - but
      // otherwise invisible: filesUpdated just reaches the caller as a smaller-than-expected
      // number with no signal why.
      logger?.warn(
        `applyTaxonomySuggestions: ${skipped}/${updates.length} file(s) skipped on batch ${batchId} - tags changed since read`
      );
    }

    const finalized = await db.batches.setTaxonomyStatusIfActive(batchId, ['applying'], 'applied');
    if (!finalized) {
      // Tags were written successfully, but something else (almost certainly the stuck-job
      // reconciler racing a very slow bulkWrite) moved the batch out of 'applying' first.
      // Surface it rather than silently reporting success while the stored status disagrees.
      throw new BadRequestError(
        'Tag suggestions were applied, but the batch status changed unexpectedly - please refresh.'
      );
    }

    return { success: true, filesUpdated };
  } catch (error) {
    // Revert the claim so the batch isn't stranded in 'applying' (invisible to the fast
    // read-time reconciler path notwithstanding, this keeps the state machine honest without
    // waiting on the daily cron). Re-running apply with the same acceptedTags is safe: the
    // merge-by-name logic above is idempotent, so a retry after a partial bulkWrite failure
    // can never duplicate or lose a tag.
    await db.batches.setTaxonomyStatusIfActive(batchId, ['applying'], 'ready').catch(() => {});
    throw error;
  }
};
