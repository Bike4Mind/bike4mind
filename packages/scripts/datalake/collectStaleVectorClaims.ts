/**
 * The pairing behind `check-stale-vector-claims` (#2583), split out from the script so it is
 * testable without a live DB: the script owns the connection, the argv and the reporting, this owns
 * the sweep and the repair. A file is stale when it DECLARES vectorized chunks
 * (`vectorizedChunkCount > 0`) but has zero rows in fabfilechunks - unretrievable by both read paths
 * while every counter-based health surface reads it as vectorized.
 */

export interface StaleVectorClaimCandidate {
  id: string;
  fileName?: string;
}

export interface StaleVectorClaimDeps {
  /** Page of files declaring a positive count, ordered by id, strictly after `afterFileId`. */
  findFileIdsWithPositiveVectorizedCount(options: {
    limit?: number;
    afterFileId?: string;
  }): Promise<StaleVectorClaimCandidate[]>;
  /** The subset of `fabFileIds` that have at least one chunk row. */
  findFabFileIdsWithChunks(fabFileIds: string[]): Promise<Set<string>>;
}

export interface StaleVectorClaimReport {
  scanned: number;
  stale: StaleVectorClaimCandidate[];
}

export async function collectStaleVectorClaims(
  deps: StaleVectorClaimDeps,
  { batchSize }: { batchSize: number }
): Promise<StaleVectorClaimReport> {
  let afterFileId: string | undefined;
  let scanned = 0;
  const stale: StaleVectorClaimCandidate[] = [];

  for (;;) {
    const page = await deps.findFileIdsWithPositiveVectorizedCount({ limit: batchSize, afterFileId });
    if (page.length === 0) break;
    // The ONLY thing advancing the loop: the sole exit is an empty page, so a cursor that fails to
    // move past the last id of the page re-reads it forever. Pinned by the pagination test.
    afterFileId = page[page.length - 1].id;
    scanned += page.length;

    const withChunks = await deps.findFabFileIdsWithChunks(page.map(file => file.id));
    for (const file of page) {
      if (!withChunks.has(file.id)) stale.push(file);
    }
  }

  return { scanned, stale };
}

export interface StaleVectorClaimRepairDeps {
  /** The canonical reset (`fabFileRepository.resetChunkStateByIds`); returns only the ids it changed. */
  resetChunkStateByIds(ids: string[]): Promise<string[]>;
}

export interface StaleVectorClaimRepair {
  reset: string[];
  /** Selected but not reset - a worker held `isChunking` at the moment of the write. */
  skipped: string[];
}

/**
 * Make the flagged files stop asserting a corpus that is not there.
 *
 * `resetChunkStateByIds` is the whole repair, and it is enough for both halves of the population
 * the issue splits (#2583). For a file outside any lake it simply makes the counter honest. For a
 * lake member it ALSO enrolls the file in the repair door that already exists: the reset writes
 * `chunkRebuildRequestedAt` alongside `vectorizedChunkCount: 0`, `error: null` and
 * `isChunking: false`, which is exactly the STALE-PENDING arm of
 * `FabFileModel.findConvergencePausedFilesByScope` once REBUILD_PENDING_STALE_MS has passed - so
 * the lake's own "Rebuild passages" surface offers the re-vectorize, and this script does not grow
 * a second copy of the queue-send machinery to do it.
 *
 * Deliberately NOT preceded by a re-read: the sweep's selection is `vectorizedChunkCount > 0` with
 * no chunk rows, and the per-document `isChunking: {$ne: true}` precondition inside the reset is
 * what keeps it off a file a worker has since claimed. A file that gained real chunks between the
 * sweep and here is reset anyway - correctly, since a rebuild is the safe outcome either way.
 */
export async function repairStaleVectorClaims(
  deps: StaleVectorClaimRepairDeps,
  ids: string[]
): Promise<StaleVectorClaimRepair> {
  if (ids.length === 0) return { reset: [], skipped: [] };
  const reset = await deps.resetChunkStateByIds(ids);
  // Report the shortfall rather than the request. The reset returns only the ids it actually
  // changed, so treating `ids` as the result would report a clean repair over files still claiming
  // chunks they do not have - the same silent-success this whole issue is about.
  const resetSet = new Set(reset);
  return { reset, skipped: ids.filter(id => !resetSet.has(id)) };
}
