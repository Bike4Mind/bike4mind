import type {
  IDataLakeAccessGrantRepository,
  IDataLakeBatchRepository,
  IDataLakeRepository,
  IFabFileRepository,
  TaxonomyTag,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError, folderTagForFile, tagsForFile } from '@bike4mind/common';
import { type ManageActor } from './manageRule';
import { resolveCanManageLake } from './authorizeLakeManage';
import { collidesWithRegistryPrefix } from './tagPrefixCollision';

interface ApplyTaxonomySuggestionsAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById'>;
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
    batches: Pick<IDataLakeBatchRepository, 'findById' | 'setTaxonomyStatusIfActive'>;
    fabFiles: Pick<IFabFileRepository, 'findByBatchId' | 'bulkUpdateTags'>;
  };
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
  metrics?: { recordTagsApplySkipped: (count: number) => Promise<void> };
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
 * `unchanged` counts files that already carried every tag this apply would give them, so nothing was
 * written for them. They are reported separately rather than folded into `filesUpdated` because the
 * two answer different questions - "what did this change" versus "did this succeed" - and a re-apply
 * that legitimately changes nothing would otherwise be indistinguishable from one that failed.
 *
 * `filesUpdated` can be less than the number of matched files: bulkUpdateTags applies
 * optimistic concurrency per file, so one mutated by something else between the read below and
 * the write (a direct tag edit, a lake-membership pull, another apply) is silently skipped
 * rather than having its concurrent change clobbered by a merge computed from stale data.
 */
export const applyTaxonomySuggestions = async (
  actor: ManageActor,
  batchId: string,
  acceptedTags: TaxonomyTag[],
  { db, logger, metrics }: ApplyTaxonomySuggestionsAdapters
): Promise<{ success: true; filesUpdated: number; unchanged: number; skipped: number }> => {
  const batch = await db.batches.findById(batchId);
  if (!batch) throw new NotFoundError('Batch not found');

  const lake = await db.dataLakes.findById(batch.dataLakeId);
  if (!lake) throw new NotFoundError('Data lake not found');
  if (!(await resolveCanManageLake(lake, actor, { db }))) {
    throw new BadRequestError('You do not have permission to apply tag suggestions for this data lake');
  }
  // A prefix colliding with a STATIC REGISTRY lake (e.g. opti:) has no owning document, so its
  // read arm is an ownership BYPASS - stamping tags under it would expose this lake's files to
  // everyone entitled to the registry lake. Create already refuses such a prefix (see
  // createDataLake.ts); this only catches a row that predates that check.
  if (collidesWithRegistryPrefix(lake.fileTagPrefix)) {
    // No admin remedy exists today - there is no path to change a lake's fileTagPrefix after
    // creation - so this refusal is not pointing anyone at a fix that doesn't exist.
    throw new BadRequestError(
      "This lake's tag prefix overlaps a built-in data lake, so new tags cannot be applied to it."
    );
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

    // Whether the merge produced the file's existing tag set unchanged. The merge seeds a Map from
    // `existingTags` in order and only sets names, so an unchanged result is element-wise identical -
    // no sorting needed. A legacy row holding the same name twice collapses in the Map, which makes
    // the arrays differ in LENGTH and correctly counts as a change (the write dedupes it).
    const isUnchanged = (merged: { name: string; strength: number }[], existing: typeof merged) =>
      merged.length === existing.length &&
      merged.every((t, i) => t.name === existing[i].name && t.strength === existing[i].strength);

    // Files whose merge changes nothing. Counted, not written - for two reasons, neither of which is
    // "Mongo ignores an identical $set". It does not, on this path: FabFileSchema sets
    // `timestamps: true` and Mongoose injects `updatedAt` into every bulkWrite updateOne unless a
    // `timestamps` option overrides it, which bulkUpdateTags does not pass. An identical-value op is
    // therefore genuinely modified (pinned in FabFileModel.bulkUpdateTags.test.ts).
    //
    // 1. Writing them rewrites `updatedAt` on every file in the batch for a write that changes no
    //    tags.
    // 2. It makes `skipped` below mean something. Because modifiedCount counts the timestamp bump,
    //    it is NOT a change-detector here; the subtraction only isolates lost CAS races once the
    //    no-op merges are excluded from `updates` in the first place.
    let unchanged = 0;

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
      const mergedTags = Array.from(merged, ([name, strength]) => ({ name, strength }));

      // Already carries every tag this apply would give it - the common case on a re-apply after a
      // re-analyze, or on the documented retry in the catch below.
      if (isUnchanged(mergedTags, existingTags)) {
        unchanged++;
        return [];
      }

      return [
        {
          id: file.id,
          tags: mergedTags,
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
      // Every op in `updates` would genuinely CHANGE its file - the no-op merges were counted into
      // `unchanged` above and never emitted - so a lower filesUpdated means bulkUpdateTags'
      // optimistic-concurrency check lost the race for `skipped` of them (see its doc comment).
      // That equivalence is what makes this warning trustworthy, and it depends on the filtering
      // above rather than on Mongo: an identical-value op IS reported as modified here (see the note
      // on `unchanged`), so without the split an idempotent re-apply would report every file as
      // updated and `skipped` as 0. Not an error - the concurrent writer's change legitimately wins - but
      // otherwise invisible: filesUpdated just reaches the caller as a smaller-than-expected
      // number with no signal why. Log carries batchId for grepping one occurrence; the metric
      // (deliberately dimensionless, matching this file's low-cardinality convention) is the
      // aggregate rate an alarm could eventually watch.
      //
      // A lost CAS is not the only way in: the filter carries `deletedAt: null` (FabFileModel) and
      // `findByBatchId` already excludes deleted rows, so a file soft-deleted inside this window
      // lands here too. Rare, but the message has to admit it - "tags changed since read" is the one
      // thing that definitely did not happen in that case, and it is what someone will grep on.
      logger?.warn(
        `applyTaxonomySuggestions: ${skipped}/${updates.length} file(s) skipped on batch ${batchId} - tags changed or file deleted since read`
      );
      await metrics?.recordTagsApplySkipped(skipped).catch(() => {});
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

    // `skipped` is returned, not just logged: without it the caller cannot tell "everything already
    // had these tags" from "nothing could be written", and there is no in-product retry once the
    // batch reaches 'applied' (apply requires 'ready', re-analyze requires 'ready'|'failed'), so
    // that message is the user's last word on the batch.
    return { success: true, filesUpdated, unchanged, skipped };
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
