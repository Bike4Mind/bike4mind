import { getEmbeddingDimensions } from './atlasSearchIndex';

/**
 * One OpenSearch document per FabFile chunk (id = chunk id) - NOT one document per file with a
 * nested array of chunks. A flat `vector` field means every k-NN query is a plain knn query, no
 * `nested`/`inner_hits` indirection needed to get back to a single chunk's score.
 */
export type SearchDocument = {
  id: string;
  text: string;
  vector: number[];
  metadata: {
    fabFileId: string;
    embeddingModel: string;
    sourceType: string;
  };
  score?: number;
};

/**
 * ef_construction/m are the HNSW build-time recall/latency tradeoff knobs. Left unset
 * (ef_search) uses OpenSearch's own default at query time; ef_construction/m below are picked,
 * not verified against a specific library default - retune against a real self-host corpus if
 * recall or indexing latency looks off in practice.
 */
const HNSW_METHOD = {
  name: 'hnsw',
  // Filterable engines only - self-host retrieval always filters by fabFileId/embeddingModel,
  // and OpenSearch's nmslib engine cannot filter a knn query at all.
  engine: 'lucene',
  // The score denormalization in openSearchVectorSearch.ts assumes cosine similarity;
  // OpenSearch's default space_type is l2, so this must be declared explicitly.
  space_type: 'cosinesimil',
  parameters: {
    ef_construction: 128,
    m: 16,
  },
} as const;

/** Index mapping for a given embedding model's vector width. One index per embedding model. */
export function buildSearchIndexSettings(dimension: number): Record<string, any> {
  return {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        text: { type: 'text' },
        vector: {
          type: 'knn_vector',
          dimension,
          method: HNSW_METHOD,
        },
        metadata: {
          properties: {
            fabFileId: { type: 'keyword' },
            embeddingModel: { type: 'keyword' },
            sourceType: { type: 'keyword' },
          },
        },
      },
    },
  };
}

/** Index settings for `model`, or null if the model has no registered dimension. */
export function buildSearchIndexSettingsForModel(model: string): Record<string, any> | null {
  const dimension = getEmbeddingDimensions(model);
  if (dimension == null) {
    return null;
  }
  return buildSearchIndexSettings(dimension);
}
