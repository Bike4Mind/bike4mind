import type { FabFileNotice } from '@bike4mind/utils';
import type { IFabFileRepository } from '@bike4mind/common';

export type UnresolvedFileIdsLookup = Pick<
  IFabFileRepository,
  'findExistingIdsByIds' | 'findExistingIdsIncludingDeletedByIds'
>;

export interface UnresolvedFileIdClassification {
  /** No FabFile row at all - nothing can bring it back. */
  gone: string[];
  /** A row with `deletedAt` set - unreadable for everyone until a restore, if one ever comes. */
  softDeleted: string[];
}

/**
 * Which of `referencedIds` this turn reported as resolving to no document (the `unresolved` band
 * only - every other band describes a file that WAS found), split by why. A live row the caller
 * merely could not read is in neither list: lake and entitlement resolution degrade to "less
 * access" on a failed lookup instead of throwing, so an unreadable live row cannot be told apart
 * from a transient outage and is never a basis for dropping a reference.
 *
 * Shared by every reference prune (session knowledge, the user's system files, project files) so
 * they all apply the same two gates. Throws on a lookup failure; callers are best-effort.
 */
export const classifyUnresolvedFileIds = async (
  referencedIds: string[],
  notices: FabFileNotice[],
  fabFiles: UnresolvedFileIdsLookup
): Promise<UnresolvedFileIdClassification> => {
  const referenced = new Set(referencedIds);
  const candidates = Array.from(
    new Set(notices.filter(notice => notice.band === 'unresolved').map(notice => notice.fabFileId))
  ).filter(id => referenced.has(id));
  if (candidates.length === 0) return { gone: [], softDeleted: [] };

  const [anyRow, liveRow] = await Promise.all([
    fabFiles.findExistingIdsIncludingDeletedByIds(candidates),
    fabFiles.findExistingIdsByIds(candidates),
  ]);
  const existing = new Set(anyRow);
  const live = new Set(liveRow);
  return {
    gone: candidates.filter(id => !existing.has(id)),
    softDeleted: candidates.filter(id => existing.has(id) && !live.has(id)),
  };
};
