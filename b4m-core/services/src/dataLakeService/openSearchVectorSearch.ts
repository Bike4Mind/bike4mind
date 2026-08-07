import type { SemanticChunkResult } from './semanticDataLakeSearch';
import { classifyAnnHit } from './embeddingMismatch';

export interface OpenSearchVectorSearchAdapters {
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

export interface OpenSearchVectorSearchResult {
  results: SemanticChunkResult[];
  hitsReturned: number;
  hitsSkippedUnknownFile: number;
  /** Same "queryable but zero raw hits" signal as AtlasVectorSearchResult.filesWithHits - see there. */
  filesWithHits: Set<string>;
}

/**
 * Run a self-host OpenSearch kNN query over an already-eligibility-checked file subset and
 * shape the hits into the same `SemanticChunkResult` rows the brute-force scan and the Atlas
 * path produce, so all three can merge into one BoundedTopK.
 *
 * The `2 * score - 1` denormalization is identical to atlasVectorSearch.ts's, not a coincidence:
 * config.ts's index mapping deliberately pins `engine: 'lucene', space_type: 'cosinesimil'`,
 * under which OpenSearch's k-NN score is `(1 + cosine) / 2` - the same normalized range Atlas's
 * `similarity: 'cosine'` scoring uses. If that mapping ever changes engine/space_type, this
 * formula must be revisited alongside it.
 */
export async function openSearchVectorSearch(args: {
  fileIds: string[];
  fileById: Map<string, AnnRankableFile>;
  queryVector: number[];
  model: string;
  limit: number;
  minScore: number;
  adapters: OpenSearchVectorSearchAdapters;
}): Promise<OpenSearchVectorSearchResult> {
  const { fileIds, fileById, queryVector, model, limit, minScore, adapters } = args;
  if (fileIds.length === 0) {
    return { results: [], hitsReturned: 0, hitsSkippedUnknownFile: 0, filesWithHits: new Set() };
  }

  const hits = await adapters.knnSearch(fileIds, queryVector, model, { limit });
  const filesWithHits = new Set(hits.map(h => h.fabFileId));

  const results: SemanticChunkResult[] = [];
  let hitsSkippedUnknownFile = 0;

  for (const hit of hits) {
    const file = fileById.get(hit.fabFileId);
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
