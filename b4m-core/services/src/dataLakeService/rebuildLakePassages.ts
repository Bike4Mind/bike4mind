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
    fabFiles: Pick<IFabFileRepository, 'findChunkedFilesByScope' | 'findConvergencePausedFilesByScope'>;
    fabFileChunks: Pick<IFabFileChunkRepository, 'findUnderChunkedFabFileIds'>;
  };
};

/**
 * The lake's files that "Rebuild passages" must repair, paired with the owner userId needed to
 * re-enqueue their chunk job. Two populations, and they are found by different reads because they
 * have opposite shapes:
 *
 *  - UNDER-CHUNKED: a chunk larger than `tokenThreshold` - a legacy whole-document blob rather than
 *    a ~512-token passage, which retrieval cannot rank within. Found by scanning the chunk rows.
 *  - STRANDED: no searchable passage, because the kill switch halted its repair. Either its passages
 *    were DELETED (chunkless, so the under-chunked read cannot see it) or they exist carrying no
 *    vector (which the under-chunked read only surfaces if a chunk is ALSO oversized - a correctly
 *    chunked one is not). `error:null` on both, so `countFailedLakeFiles` misses them too. Selected
 *    by the marker plus a zero vector count instead - see findConvergencePausedFilesByScope.
 *
 * Stranded members lead the result, ahead of any overshoot and matching `planLakeConvergence`'s own
 * ordering: they return NOTHING today, where an under-chunked file at least returns something.
 * Without them this door reported `underChunkedCount: 0` and hid its own button on precisely the
 * lake that needed it - the fourth reader of the same marker health, convergence and the retrieval
 * withhold already key on.
 *
 * Pure over its repo seams: given a lake and the reads, it does no I/O of its own, so it is
 * unit-testable without a database.
 */
export const detectUnderChunkedFiles = async (
  lake: ScopeSourceLake,
  { db }: DetectDeps,
  tokenThreshold: number = OVERSIZED_PASSAGE_TOKEN_THRESHOLD
): Promise<UnderChunkedFile[]> => {
  const scope = lakeMembershipScope(lake);
  const [files, stranded] = await Promise.all([
    db.fabFiles.findChunkedFilesByScope(scope),
    db.fabFiles.findConvergencePausedFilesByScope(scope),
  ]);
  const strandedFirst: UnderChunkedFile[] = stranded.map(f => ({ fabFileId: f.id, userId: f.userId }));
  if (files.length === 0) return strandedFirst;

  const ownerById = new Map(files.map(f => [f.id, f.userId]));
  const underChunkedIds = await db.fabFileChunks.findUnderChunkedFabFileIds(
    files.map(f => f.id),
    tokenThreshold
  );

  // findUnderChunkedFabFileIds only sees ids we passed in, so ownerById always has the userId;
  // the filter(Boolean) is a defensive guard, not an expected path.
  const underChunked = underChunkedIds
    .map(fabFileId => {
      const userId = ownerById.get(fabFileId);
      return userId ? { fabFileId, userId } : null;
    })
    .filter((f): f is UnderChunkedFile => f !== null);

  // The two reads CAN overlap now that stranded covers the vectorize arm: such a file is
  // `chunked:true`, so it is in findChunkedFilesByScope's set, and if one of its chunks is also
  // oversized it is genuinely both. Deduped on fabFileId with stranded winning, because the caller
  // enqueues one chunk job per entry and a duplicate would double-charge the embedder for the same
  // file - and because `underChunkedCount` is rendered as a file count.
  const seen = new Set(strandedFirst.map(f => f.fabFileId));
  return [...strandedFirst, ...underChunked.filter(f => !seen.has(f.fabFileId))];
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
