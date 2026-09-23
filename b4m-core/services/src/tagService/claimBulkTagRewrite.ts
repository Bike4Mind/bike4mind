import type { IFabFileRepository } from '@bike4mind/common';
import type { MembershipTransitionFile } from '../dataLakeService/recordMembershipTransitions';
import { renamedTagName, storedTagNames, withoutTagName } from './bulkTagNames';

interface ClaimAdapters {
  db: { fabFiles: Pick<IFabFileRepository, 'claimTagRewriteByUserId'> };
  /**
   * Hands off one file's transition as soon as its own claim has landed, before the next claim is
   * attempted. Buffering them all until the loop returns loses every fact already written if a
   * later claim throws, and a retry cannot reconstruct them - the source tag is gone off the files
   * this call already rewrote.
   */
  onClaimed?: (file: MembershipTransitionFile) => Promise<void>;
}

/**
 * Apply a bulk tag rename (`newTag`) or delete (`newTag: null`) one file at a time, each under a
 * write that claims the file itself, and report the per-file before/after states those writes
 * actually produced.
 *
 * This is the shape the membership change log needs from the bulk tag doors. Reading a snapshot and
 * then issuing one `updateMany` cannot support a per-file durable fact: the count is aggregate, so
 * two requests renaming the same tag concurrently both read the same files, both compute the same
 * transitions, and both append them - while only one of them moved anything. Here a file appears in
 * the result only if this caller's own write is the one that rewrote it.
 *
 * Only the files a rewrite genuinely touched are claimed, so the round trips are proportional to the
 * real work rather than to the user's library. The caller still runs the plain bulk write afterwards:
 * it is idempotent over what was claimed here and remains the only thing that reaches soft-deleted
 * files and the `primaryTag` field.
 *
 * Every claim is durably accounted for through `onClaimed` before the next one is attempted, so a
 * mid-loop failure leaves the files it already rewrote with their facts recorded. The returned
 * array is the same set, for callers that need the count.
 */
export const claimBulkTagRewrite = async (
  userId: string,
  tag: string,
  newTag: string | null,
  { db, onClaimed }: ClaimAdapters
): Promise<MembershipTransitionFile[]> => {
  const claimed: MembershipTransitionFile[] = [];
  const claimedIds: string[] = [];
  for (;;) {
    // A copy: the repository must not be handed a list that keeps growing under it.
    const prior = await db.fabFiles.claimTagRewriteByUserId(userId, tag, newTag, [...claimedIds]);
    if (!prior) break;
    claimedIds.push(prior.id);
    const beforeTagNames = storedTagNames(prior);
    const file: MembershipTransitionFile = {
      fabFileId: prior.id,
      userId: prior.userId,
      beforeTagNames,
      afterTagNames: newTag ? renamedTagName(beforeTagNames, tag, newTag) : withoutTagName(beforeTagNames, tag),
    };
    claimed.push(file);
    await onClaimed?.(file);
  }
  return claimed;
};
