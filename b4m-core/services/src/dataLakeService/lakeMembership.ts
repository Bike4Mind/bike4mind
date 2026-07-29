import { DATALAKE_TAG_PREFIX, DATALAKE_TAG_STRENGTH, normalizeTagPrefix } from '@bike4mind/common';
import type { IDataLakeDocument, IFabFileRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { assertLakeWritable } from './assertLakeAccess';
import { canManageLake } from './authorizeLakeWrite';

/** The acting principal for a membership write - resolved from auth, never from the body. */
export type MembershipActor = { userId: string; isAdmin: boolean };

/**
 * The lake fields a membership write needs. Taking the resolved document rather than an id lets
 * a caller that already holds the lake (or resolved it by meta-tag rather than by id) reuse it
 * instead of refetching.
 */
export type MembershipLake = Pick<IDataLakeDocument, 'id' | 'datalakeTag' | 'fileTagPrefix' | 'createdByUserId'>;

interface RemoveMembershipAdapters {
  db: { fabFiles: Pick<IFabFileRepository, 'findById' | 'pullTagsByFabFileId'> };
}

interface AddMembershipAdapters {
  db: { fabFiles: Pick<IFabFileRepository, 'pushTagsByFabFileId'> };
}

/**
 * The membership half of `removeFileFromDataLake`, without the stats recompute: clears EVERY
 * signal the read path honors - the lake's `datalake:` meta-tag and any tag carrying the lake's
 * `fileTagPrefix` - in one atomic write. The rationale for clearing both, for the ownership
 * conjunct on the prefix arm, and for leaving the file and its chunks alone lives on the
 * exported `removeFileFromDataLake`; read that first.
 *
 * Split out so a batch caller can remove several files and recompute the lake's stats ONCE at
 * the end instead of re-running the aggregate per file. A caller that skips the recompute owns
 * running it: until it does, `fileCount`/`totalSizeBytes` are stale.
 */
export const removeFileFromLake = async (
  actor: MembershipActor,
  lake: MembershipLake,
  fabFileId: string,
  { db }: RemoveMembershipAdapters
): Promise<void> => {
  if (!canManageLake(lake, actor)) {
    throw new BadRequestError('Only the creator can remove files from this data lake');
  }
  // A fallback lake has no document to hold membership, so there is nothing to remove from.
  assertLakeWritable(lake);

  const file = await db.fabFiles.findById(fabFileId);
  const tagNames = (file?.tags ?? []).map(t => t.name).filter((name): name is string => typeof name === 'string');
  // Normalized through the same predicate the read arms use, so a lake whose prefix no query
  // matches (empty, or missing its trailing colon) also gets nothing cleared by prefix.
  const prefix = normalizeTagPrefix(lake.fileTagPrefix);
  // Positive ownership: both ids must be present AND equal, so a file with no owner does not
  // fall through as a match.
  const ownsFile = actor.isAdmin || (!!file?.userId && file.userId === actor.userId);
  const prefixedTags = prefix ? tagNames.filter(name => name.startsWith(prefix)) : [];
  const inLake = !!file && (tagNames.includes(lake.datalakeTag) || (ownsFile && prefixedTags.length > 0));
  if (!file || !inLake) {
    throw new NotFoundError('File not found in this data lake');
  }

  // One atomic $pull for both signals. Two writes would leave a window - and on a crash, a
  // permanent state - where the meta-tag is gone but a prefixed tag still matches this lake.
  await db.fabFiles.pullTagsByFabFileId(file.id, [
    lake.datalakeTag,
    // Never strip another lake's membership: a lake whose fileTagPrefix sits inside the
    // reserved datalake: namespace would otherwise evict the file from every lake at once.
    ...prefixedTags.filter(name => !name.startsWith(DATALAKE_TAG_PREFIX)),
  ]);
};

/**
 * Add a file to a lake by stamping the lake's canonical meta-tag, atomically and idempotently -
 * a file already in the lake is left exactly as it is.
 *
 * Deliberately NOT the mirror image of the removal: removal clears the lake's prefixed content
 * tags too, and this does not restore them. Those tags are assigned when a file is ingested into
 * the lake and cannot be reconstructed from the lake plus the file, so a file removed and then
 * re-added is a member again but has lost its folder grouping within the lake.
 *
 * Writes `lake.datalakeTag` from the document rather than whatever the caller spelled, so a
 * mixed-case meta-tag from a request body cannot create a second, non-matching membership tag.
 * Stats are the caller's job here as well; see `removeFileFromLake`.
 */
export const addFileToLake = async (
  actor: MembershipActor,
  lake: MembershipLake,
  fabFileId: string,
  { db }: AddMembershipAdapters
): Promise<void> => {
  if (!canManageLake(lake, actor)) {
    throw new BadRequestError('Only the creator can add files to this data lake');
  }
  assertLakeWritable(lake);

  await db.fabFiles.pushTagsByFabFileId(fabFileId, [lake.datalakeTag], DATALAKE_TAG_STRENGTH);
};
