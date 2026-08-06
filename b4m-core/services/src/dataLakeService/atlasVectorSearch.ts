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
}

/**
 * Run Atlas `$vectorSearch` over an already-eligibility-checked file subset (see
 * vectorSearchEligibility.ts) and shape the hits into the same `SemanticChunkResult` rows the
 * brute-force scan produces, so the two can merge into one BoundedTopK.
 *
 * `minScore` is re-applied here even though the query only returns its best `limit` matches:
 * Atlas's `limit` bounds candidates by SIMILARITY RANK, not by score threshold, so a low-signal
 * corpus could otherwise return hits the scan path would have rejected under the same minScore.
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
  if (fileIds.length === 0) return { results: [], hitsReturned: 0, hitsSkippedUnknownFile: 0 };

  const hits = await adapters.vectorSearch(fileIds, queryVector, model, { limit });

  const results: SemanticChunkResult[] = [];
  let hitsSkippedUnknownFile = 0;

  for (const hit of hits) {
    const file = fileById.get(hit.fabFileId);
    if (classifyAnnHit({ parentFile: file })) {
      hitsSkippedUnknownFile++;
      continue;
    }
    if (hit.score < minScore) continue;
    results.push({
      chunkId: hit.id,
      fileId: hit.fabFileId,
      fileName: file!.fileName,
      fileTags: file!.fileTags,
      chunkText: hit.text,
      score: hit.score,
    });
  }

  return { results, hitsReturned: hits.length, hitsSkippedUnknownFile };
}
