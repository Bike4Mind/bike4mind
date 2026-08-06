import type { Connection } from 'mongoose';
import { supportsAtlasVectorSearch } from '@bike4mind/db-core';
import { Logger } from '@bike4mind/observability';
import { OPENAI_EMBEDDING_MODEL_MAP } from '../embeddings/providers/OpenAIEmbeddingService';
import { VOYAGEAI_EMBEDDING_MODEL_MAP } from '../embeddings/providers/VoyageAIEmbeddingService';
import { BEDROCK_EMBEDDING_MODEL_MAP } from '../embeddings/providers/BedrockEmbeddingService';
import { OLLAMA_EMBEDDING_MODEL_MAP } from '../embeddings/providers/OllamaEmbeddingService';

/**
 * Atlas Search index management for Data Lake chunk vectors, one index per embedding model.
 *
 * An Atlas Search index mapping is static, and embedding dimensions vary across models
 * (1024-3072 in the current registry), so a single shared index cannot serve every model - a
 * write under one model's width would corrupt the mapping for every other model sharing the
 * index. Every model below is keyed by its ACTUAL write-time width: `EmbeddingModelInfo.dimensions[0]`,
 * because no caller in this codebase overrides `outputDimension` today, so `dimensions[0]` is
 * what every chunk vector for that model is actually stored at.
 *
 * Every index also declares `fabFileId` and `embeddingModel` as `filter` fields - without them,
 * a `$vectorSearch` query with a `filter` on either path throws at query time (Atlas rejects
 * filtering on a path the index doesn't declare as filterable), which would make the whole
 * cutover permanently fall back to the brute-force scan.
 */

const FABFILECHUNK_COLLECTION = 'fabfilechunks'; // must match FabFileChunk's mongoose collection name (packages/database)

const VECTOR_PATH = 'vector';
const FILTER_PATHS = ['fabFileId', 'embeddingModel'] as const;

// A Map, not a plain object: a bracket lookup on an object literal returns inherited
// prototype values (e.g. 'constructor') instead of undefined, so an unrecognized model would
// fail OPEN with a garbage AtlasIndexTarget rather than closed to null.
const ALL_MODEL_DIMENSIONS: Map<string, number> = new Map(
  [
    ...Object.values(OPENAI_EMBEDDING_MODEL_MAP),
    ...Object.values(VOYAGEAI_EMBEDDING_MODEL_MAP),
    ...Object.values(BEDROCK_EMBEDDING_MODEL_MAP),
    ...Object.values(OLLAMA_EMBEDDING_MODEL_MAP),
  ].map(info => [info.model, info.dimensions[0]] as const)
);

export const getEmbeddingDimensions = (model: string): number | null => ALL_MODEL_DIMENSIONS.get(model) ?? null;

/** Every registered model whose write-time width equals `numDimensions` - used to guess a legacy chunk's model from its stored vector length. */
export const modelsWithDimensions = (numDimensions: number): string[] =>
  [...ALL_MODEL_DIMENSIONS.entries()]
    .filter(([, dims]) => dims === numDimensions)
    .map(([model]) => model)
    .sort();

/** Atlas index names allow only letters, numbers, hyphens and underscores. */
const sanitizeForIndexName = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '_');

export const atlasVectorIndexName = (model: string, numDimensions: number): string =>
  `datalake_vs_${sanitizeForIndexName(model)}_${numDimensions}`;

export interface AtlasIndexTarget {
  name: string;
  numDimensions: number;
}

export const getAtlasIndexForModel = (model: string): AtlasIndexTarget | null => {
  const numDimensions = getEmbeddingDimensions(model);
  if (numDimensions === null) return null;
  return { name: atlasVectorIndexName(model, numDimensions), numDimensions };
};

/** An Atlas `vectorSearch`-type search index description, as accepted by `Collection.createSearchIndex`. */
export interface AtlasVectorIndexDefinition {
  name: string;
  type: 'vectorSearch';
  definition: {
    fields: Array<
      { type: 'vector'; path: string; numDimensions: number; similarity: 'cosine' } | { type: 'filter'; path: string }
    >;
  };
}

export const buildAtlasVectorIndexDefinition = (model: string): AtlasVectorIndexDefinition | null => {
  const target = getAtlasIndexForModel(model);
  if (!target) return null;

  return {
    name: target.name,
    type: 'vectorSearch',
    definition: {
      fields: [
        { type: 'vector', path: VECTOR_PATH, numDimensions: target.numDimensions, similarity: 'cosine' },
        ...FILTER_PATHS.map(path => ({ type: 'filter' as const, path })),
      ],
    },
  };
};

export const allAtlasVectorIndexDefinitions = (): AtlasVectorIndexDefinition[] =>
  [...ALL_MODEL_DIMENSIONS.keys()]
    .map(buildAtlasVectorIndexDefinition)
    .filter((def): def is AtlasVectorIndexDefinition => def !== null);

/**
 * Idempotently ensures every per-model Atlas vector index exists. Called from
 * `updateDatabase`/`createDatabase` rather than a numbered migration - see
 * `apps/client/server/utils/manageDatabase.ts`.
 *
 * No-ops entirely on a non-Atlas backend (DocumentDB/self-host), since `createSearchIndex`
 * is an Atlas-only server command and would otherwise throw on every deploy.
 *
 * Every stage (including preview) shares one Atlas cluster (see `infra/database.ts`), so a
 * per-index failure (e.g. the cluster's search-index quota) is logged and swallowed rather than
 * thrown - one model's index being unavailable must not block the deploy or the other models'
 * indexes from being created.
 */
export const ensureAtlasVectorSearchIndexes = async (conn: Connection, logger: Logger): Promise<void> => {
  if (!supportsAtlasVectorSearch()) {
    logger.log('[ensureAtlasVectorSearchIndexes] backend does not support Atlas Search, skipping');
    return;
  }

  const collection = conn.collection(FABFILECHUNK_COLLECTION);
  const existing = new Set<string>();
  try {
    for await (const doc of collection.listSearchIndexes()) {
      if (typeof doc.name === 'string') existing.add(doc.name);
    }
  } catch (error) {
    logger.warn(`[ensureAtlasVectorSearchIndexes] failed to list existing search indexes: ${error}`);
    return;
  }

  for (const definition of allAtlasVectorIndexDefinitions()) {
    if (existing.has(definition.name)) continue;
    try {
      await collection.createSearchIndex(definition);
      logger.log(`[ensureAtlasVectorSearchIndexes] created index ${definition.name}`);
    } catch (error) {
      logger.warn(`[ensureAtlasVectorSearchIndexes] failed to create index ${definition.name}: ${error}`);
    }
  }
};

interface CachedIndexStatus {
  queryable: boolean;
  status: string;
}

const STATUS_CACHE_TTL_MS = 60_000;
const statusCache = new Map<string, { value: CachedIndexStatus | null; expiresAt: number }>();

/** Test-only: clears the status cache so tests don't leak state across cases. */
export const resetAtlasIndexStatusCache = (): void => statusCache.clear();

/**
 * Whether a given model's Atlas index exists and is queryable, cached for `STATUS_CACHE_TTL_MS`
 * so the read path (checked per search) doesn't call `listSearchIndexes` on every request -
 * mongot indexing lag means this can't be a one-time check anyway.
 */
export const getAtlasIndexStatus = async (conn: Connection, model: string): Promise<CachedIndexStatus | null> => {
  const target = getAtlasIndexForModel(model);
  if (!target) return null;

  const cached = statusCache.get(target.name);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  let value: CachedIndexStatus | null = null;
  try {
    const collection = conn.collection(FABFILECHUNK_COLLECTION);
    const docs = await collection.listSearchIndexes(target.name).toArray();
    // any: the driver's ListSearchIndexesCursor type only declares `{ name }` - the real Atlas
    // server response also carries `queryable`/`status`, which the driver's types omit.
    const doc = docs[0] as unknown as { queryable?: boolean; status?: string } | undefined;
    value = doc ? { queryable: !!doc.queryable, status: String(doc.status ?? 'UNKNOWN') } : null;
  } catch {
    value = null;
  }

  // A null (not-yet-provisioned/not-queryable) result is cached for the full TTL too, same as a
  // real status - deliberate, to avoid thrashing listSearchIndexes while an index is still
  // building. Do not special-case null to re-check sooner: the per-file VECTOR_SEARCH_READY_LAG_MS
  // gate already re-checks readiness on that cadence.
  statusCache.set(target.name, { value, expiresAt: now + STATUS_CACHE_TTL_MS });
  return value;
};
