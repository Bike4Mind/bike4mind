import type { SemanticChunkResult } from './semanticDataLakeSearch';
import { classifyAnnHit } from './embeddingMismatch';

/** What both ANN backends' adapters already satisfy: fetch nearest-neighbor hits for a query. */
export interface AnnSearchAdapter {
  knnSearch(
    fileIds: string[],
    queryVector: number[],
    model: string,
    options?: { limit?: number }
  ): Promise<Array<{ id: string; fabFileId: string; text: string; score: number }>>;
}

interface AnnRankableFile {
  fileName: string;
  fileTags: string[];
}

export interface AnnVectorSearchResult {
  results: SemanticChunkResult[];
  hitsReturned: number;
  hitsSkippedUnknownFile: number;
  /**
   * fabFileIds that produced at least one raw hit, BEFORE minScore filtering.
   *
   * Absence is NOT on its own evidence that a file is unindexed. `knnSearch` bounds by similarity
   * RANK, so at most `limit` files can appear here and every other ready file is absent simply
   * for having not ranked. Read this together with `hitsReturned`: only when the backend returned
   * FEWER than `limit` has it exhausted its indexed content, which is what makes absence
   * meaningful. See the rebucket in semanticDataLakeSearch.ts for the rule this feeds.
   */
  filesWithHits: Set<string>;
  /**
   * Wall-clock ms spent inside the backend's own ANN call, measured around that await alone so
   * the shaping loop below is excluded - this is meant to be attributable to Atlas
   * `$vectorSearch` / OpenSearch kNN, not to this module's CPU work.
   *
   * `null` when no query was issued (the empty-fileIds return below), so a search that never
   * touched the index cannot contribute a 0 ms observation. A 0 would survive the alarm's
   * Maximum untouched but quietly drag the dashboard's Average - and any percentile this metric
   * is later read with - toward a system faster than the one that ran.
   *
   * Only ever set on a SUCCESSFUL call: a query that runs past the caller's request timeout never
   * returns, so this measures the approach to that ceiling, not the crossing of it.
   */
  backendQueryMs: number | null;
}

/**
 * The slowest single backend ANN query across one search's model queries, or `null` when none of
 * them reached a backend.
 *
 * A MAXIMUM, not a sum. A search queries its primary model and then every alternate model
 * CONCURRENTLY (`Promise.all` in semanticDataLakeSearch), so adding the durations together
 * reports a wait that never happened. Max is also the statistic the question needs: the failure
 * being watched for is a first-touch index page-in, which is one pathological query among healthy
 * ones, not a uniform slowdown.
 *
 * Nulls are dropped rather than coerced to 0, so a model that never reached the backend cannot
 * invent an observation or pull the maximum down.
 *
 * Read as a lower bound on ANN wall clock: the primary query runs before the alternates and each
 * alternate embeds its query first, so the phase always costs at least this and usually more.
 */
export function slowestAnnQueryMs(durationsMs: ReadonlyArray<number | null>): number | null {
  const observed = durationsMs.filter((ms): ms is number => ms !== null);
  return observed.length > 0 ? Math.max(...observed) : null;
}

/**
 * Shared core behind `atlasVectorSearch` and `openSearchVectorSearch` - both backends shape raw
 * ANN hits into the same `SemanticChunkResult` rows and apply the identical `2 * score - 1`
 * cosine denormalization (Atlas's `similarity: 'cosine'` and OpenSearch's `space_type:
 * cosinesimil` both score in the same [0,1]-normalized range), so the two backend-specific
 * wrappers exist only to name their own adapter method (`vectorSearch` vs `knnSearch`) and result
 * type for their callers. Keep behavior changes here, not duplicated in both wrappers.
 *
 * `minScore` is re-applied here even though the query only returns its best `limit` matches: both
 * backends' `limit` bounds candidates by SIMILARITY RANK, not by score threshold, so a low-signal
 * corpus could otherwise return hits the scan path would have rejected under the same minScore.
 */
export async function annVectorSearch(args: {
  fileIds: string[];
  fileById: Map<string, AnnRankableFile>;
  queryVector: number[];
  model: string;
  limit: number;
  minScore: number;
  adapter: AnnSearchAdapter;
}): Promise<AnnVectorSearchResult> {
  const { fileIds, fileById, queryVector, model, limit, minScore, adapter } = args;
  if (fileIds.length === 0) {
    return { results: [], hitsReturned: 0, hitsSkippedUnknownFile: 0, filesWithHits: new Set(), backendQueryMs: null };
  }

  const backendStartedAt = Date.now();
  const hits = await adapter.knnSearch(fileIds, queryVector, model, { limit });
  const backendQueryMs = Date.now() - backendStartedAt;
  const filesWithHits = new Set(hits.map(h => h.fabFileId));

  const results: SemanticChunkResult[] = [];
  let hitsSkippedUnknownFile = 0;

  for (const hit of hits) {
    const file = fileById.get(hit.fabFileId);
    // Narrow on `file` directly rather than on classifyAnnHit's return - it decides the skip
    // REASON, but the type-narrowing must not depend on a helper that could later classify a
    // non-null file as skippable too.
    //
    // hitsSkippedUnknownFile counts both branches. classifyAnnHit currently only returns
    // 'unknownFile' for a falsy parentFile, so the count is accurate today; if it ever grows a
    // reason for a TRUTHY file (dimension/model mismatch), that hit would be counted here too
    // and the name would undercount its own scope - rename or split the counter at that point.
    if (!file || classifyAnnHit({ parentFile: file })) {
      hitsSkippedUnknownFile++;
      continue;
    }
    const score = 2 * hit.score - 1;
    if (score < minScore) continue;
    results.push({
      chunkId: hit.id,
      fileId: hit.fabFileId,
      fileName: file.fileName,
      fileTags: file.fileTags,
      chunkText: hit.text,
      score,
    });
  }

  return { results, hitsReturned: hits.length, hitsSkippedUnknownFile, filesWithHits, backendQueryMs };
}
