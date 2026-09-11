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
  /**
   * Parent-document date for the passage header (#2236). Structurally satisfied by the caller's
   * `RankableFile`, so this stays the narrow shape this module actually reads.
   */
  createdAt?: Date | string | null;
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
    return { results: [], hitsReturned: 0, hitsSkippedUnknownFile: 0, filesWithHits: new Set() };
  }

  const hits = await adapter.knnSearch(fileIds, queryVector, model, { limit });
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
      fileCreatedAt: file.createdAt ?? null,
    });
  }

  return { results, hitsReturned: hits.length, hitsSkippedUnknownFile, filesWithHits };
}
