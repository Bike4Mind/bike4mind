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
 *  - STRANDED: passages DELETED by a convergence wave the kill switch halted. It has no chunk rows
 *    to scan and `chunked:false`, so the under-chunked read cannot see it, and `error:null` keeps it
 *    out of `countFailedLakeFiles` too. Selected by its marker instead.
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

  // The two reads cannot overlap - one requires chunked:true, the other chunkCount <= 0 - so this is
  // a concatenation, not a merge. Dedupe would only hide a future divergence between them.
  return [...strandedFirst, ...underChunked];
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
