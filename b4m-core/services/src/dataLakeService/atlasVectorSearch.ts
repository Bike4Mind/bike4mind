import type { SemanticChunkResult } from './semanticDataLakeSearch';
import { classifyAnnHit } from './embeddingMismatch';

export interface AtlasVectorSearchAdapters {
  vectorSearch(
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

export interface AtlasVectorSearchResult {
  results: SemanticChunkResult[];
  hitsReturned: number;
  hitsSkippedUnknownFile: number;
  /**
   * fabFileIds that produced at least one raw hit, BEFORE minScore filtering. A file absent here
   * returned zero indexed chunks for this query - not "nothing scored well enough" - so the
   * caller can tell "queryable index, no matches" apart from "not actually indexed yet" and
   * rebucket the latter onto the scan path instead of silently returning zero results for it.
   */
  filesWithHits: Set<string>;
}

/**
 * Run Atlas `$vectorSearch` over an already-eligibility-checked file subset (see
 * vectorSearchEligibility.ts) and shape the hits into the same `SemanticChunkResult` rows the
 * brute-force scan produces, so the two can merge into one BoundedTopK.
 *
 * `minScore` is re-applied here even though the query only returns its best `limit` matches:
 * Atlas's `limit` bounds candidates by SIMILARITY RANK, not by score threshold, so a low-signal
 * corpus could otherwise return hits the scan path would have rejected under the same minScore.
 *
 * Atlas normalizes a `similarity: 'cosine'` score to `(1 + cosine) / 2` (range [0,1]) - a
 * different scale than the scan path's `computeCosineSimilarity`, which returns raw cosine
 * (range [-1,1]). Denormalized back to raw cosine below so both paths' scores are directly
 * comparable in the merged BoundedTopK and against the same minScore.
 */
export async function atlasVectorSearch(args: {
  fileIds: string[];
  fileById: Map<string, AnnRankableFile>;
  queryVector: number[];
  model: string;
  limit: number;
  minScore: number;
  adapters: AtlasVectorSearchAdapters;
}): Promise<AtlasVectorSearchResult> {
  const { fileIds, fileById, queryVector, model, limit, minScore, adapters } = args;
  if (fileIds.length === 0) {
    return { results: [], hitsReturned: 0, hitsSkippedUnknownFile: 0, filesWithHits: new Set() };
  }

  const hits = await adapters.vectorSearch(fileIds, queryVector, model, { limit });
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

  return { results, hitsReturned: hits.length, hitsSkippedUnknownFile, filesWithHits };
}
