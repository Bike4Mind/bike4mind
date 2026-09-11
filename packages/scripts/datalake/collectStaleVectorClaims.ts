/**
 * The pairing behind `check-stale-vector-claims` (#2583), split out from the script so it is
 * testable without a live DB: the script owns the connection, the argv and the reporting, this owns
 * the sweep. A file is stale when it DECLARES vectorized chunks (`vectorizedChunkCount > 0`) but has
 * zero rows in fabfilechunks - unretrievable by both read paths while every counter-based health
 * surface reads it as vectorized.
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
