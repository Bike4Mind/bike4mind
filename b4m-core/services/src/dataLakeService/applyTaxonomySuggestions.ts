import type { IDataLakeBatchRepository, IDataLakeRepository, IFabFileRepository, TaxonomyTag } from '@bike4mind/common';
import { BadRequestError, NotFoundError, folderTagForFile, tagsForFile } from '@bike4mind/common';
import { canManageLake } from './authorizeLakeWrite';

const APPLY_CONCURRENCY = 10;

interface ApplyTaxonomySuggestionsAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById'>;
    batches: Pick<IDataLakeBatchRepository, 'findById' | 'setTaxonomyStatusIfActive'>;
    fabFiles: Pick<IFabFileRepository, 'findByBatchId' | 'update'>;
  };
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
 */
export const applyTaxonomySuggestions = async (
  actor: { userId: string; isAdmin: boolean },
  batchId: string,
  acceptedTags: TaxonomyTag[],
  { db }: ApplyTaxonomySuggestionsAdapters
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

  const taxonomySet = { tags: acceptedTags, fileAssignments: batch.taxonomySuggestions?.fileAssignments ?? [] };
  const files = await db.fabFiles.findByBatchId(batchId);

  let filesUpdated = 0;
  for (let i = 0; i < files.length; i += APPLY_CONCURRENCY) {
    const chunk = files.slice(i, i + APPLY_CONCURRENCY);
    await Promise.all(
      chunk.map(async file => {
        const relativePath = file.relativePath ?? file.fileName;
        const folderTags = folderTagForFile(relativePath, lake.fileTagPrefix);
        const folderTagNames = new Set(folderTags.map(t => t.name));
        // The folder tag is already on the file from upload - keep only the taxonomy-derived
        // portion so re-running this can never duplicate it.
        const newTags = tagsForFile(relativePath, taxonomySet, lake.fileTagPrefix).filter(
          t => !folderTagNames.has(t.name)
        );
        if (newTags.length === 0) return;

        const existingTags = file.tags ?? [];
        const merged = new Map(existingTags.map(t => [t.name, t.strength]));
        for (const t of newTags) {
          const current = merged.get(t.name);
          if (current === undefined || t.strength > current) merged.set(t.name, t.strength);
        }

        await db.fabFiles.update({
          id: file.id,
          tags: Array.from(merged, ([name, strength]) => ({ name, strength })),
        });
        filesUpdated++;
      })
    );
  }

  await db.batches.setTaxonomyStatusIfActive(batchId, ['applying'], 'applied');
  return { success: true, filesUpdated };
};
