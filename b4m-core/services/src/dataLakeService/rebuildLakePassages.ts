import type { IDataLakeDocument, IFabFileRepository, IFabFileChunkRepository } from '@bike4mind/common';
import { OVERSIZED_PASSAGE_TOKEN_THRESHOLD } from '@bike4mind/common';
import { lakeMembershipScope } from './lakeMembershipScope';

/** Default files re-chunked per "Rebuild passages" call. Small so a single wave never bursts the
 *  embedding provider's tokens-per-minute; the caller repeats waves until the count reaches zero. */
export const DEFAULT_REBUILD_WAVE = 50;
/** Hard cap on one wave, so a hand-crafted request can't fan out an unbounded embedding burst. */
export const MAX_REBUILD_WAVE = 200;

type ScopeSourceLake = Pick<IDataLakeDocument, 'datalakeTag' | 'fileTagPrefix' | 'createdByUserId'>;

export type UnderChunkedFile = { fabFileId: string; userId: string };

type DetectDeps = {
  db: {
    fabFiles: Pick<IFabFileRepository, 'findChunkedFilesByScope'>;
    fabFileChunks: Pick<IFabFileChunkRepository, 'findUnderChunkedFabFileIds'>;
  };
};

/**
 * The lake's under-chunked files - those with a chunk larger than `tokenThreshold` (a legacy
 * whole-document blob rather than a ~512-token passage) - paired with the owner userId needed to
 * re-enqueue their chunk job. Worst-first (largest oversized chunk leads), so a bounded rebuild
 * wave repairs the least-retrievable files first.
 *
 * Pure over its two repo seams: given a lake and the two collection reads, it does no I/O of its
 * own, so it is unit-testable without a database.
 */
export const detectUnderChunkedFiles = async (
  lake: ScopeSourceLake,
  { db }: DetectDeps,
  tokenThreshold: number = OVERSIZED_PASSAGE_TOKEN_THRESHOLD
): Promise<UnderChunkedFile[]> => {
  const files = await db.fabFiles.findChunkedFilesByScope(lakeMembershipScope(lake));
  if (files.length === 0) return [];

  const ownerById = new Map(files.map(f => [f.id, f.userId]));
  const underChunkedIds = await db.fabFileChunks.findUnderChunkedFabFileIds(
    files.map(f => f.id),
    tokenThreshold
  );

  // findUnderChunkedFabFileIds only sees ids we passed in, so ownerById always has the userId;
  // the filter(Boolean) is a defensive guard, not an expected path.
  return underChunkedIds
    .map(fabFileId => {
      const userId = ownerById.get(fabFileId);
      return userId ? { fabFileId, userId } : null;
    })
    .filter((f): f is UnderChunkedFile => f !== null);
};

/**
 * How many of the lake's files failed their re-chunk (error set, no chunks). These are invisible to
 * both `detectUnderChunkedFiles` and the rescue sweep, so the rebuild badge would read them as done;
 * reported alongside the under-chunked count so a manager can distinguish "finished" from "gave up".
 */
export const countFailedLakeFiles = async (
  lake: ScopeSourceLake,
  { db }: { db: { fabFiles: Pick<IFabFileRepository, 'countFailedFilesByScope'> } }
): Promise<number> => db.fabFiles.countFailedFilesByScope(lakeMembershipScope(lake));
