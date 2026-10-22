/**
 * Keeps the default embedding model's Atlas vector index paged in, so the first lake turn after an
 * idle stretch does not pay a cold `$vectorSearch`. Forced retrieval gives its ANN candidate pick
 * 3s (FORCED_RETRIEVAL_ANN_DEADLINE_MS in ChatCompletionFeatures.ts) and falls back to picking the
 * first 100 files by name past it. On production, warm picks finish in 0.15-1.5s, but the first
 * pick after hours idle has overrun every time, and a first query has been seen taking 49s.
 * Schedule: rate(5 minutes) on prod and dev (infra/cron.ts dataLakeVectorIndexKeepWarm).
 * No self-host equivalent: self-host retrieval runs on OpenSearch, not Atlas.
 */
import { isSupportedEmbeddingModel } from '@bike4mind/common';
import { adminSettingsRepository, connectDB, fabFileChunkRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'dataLakeVectorIndexKeepWarm' } });

export type KeepWarmResult =
  | { status: 'skipped'; reason: 'vector-search-off' | 'embedding-model' | 'no-index' | 'not-queryable' }
  | { status: 'warmed'; model: string; hits: number; durationMs: number };

export async function runDataLakeVectorIndexKeepWarm(): Promise<KeepWarmResult> {
  if ((await adminSettingsRepository.getSettingsValue('EnableDataLakeVectorSearch')) !== true) {
    return { status: 'skipped', reason: 'vector-search-off' };
  }

  const model = await adminSettingsRepository.getSettingsValue('defaultEmbeddingModel');
  if (typeof model !== 'string' || !isSupportedEmbeddingModel(model)) {
    logger.warn('[dataLakeVectorIndexKeepWarm] defaultEmbeddingModel is unset or unsupported', {
      model: String(model),
    });
    return { status: 'skipped', reason: 'embedding-model' };
  }

  const status = await fabFileChunkRepository.getAtlasIndexStatus(model);
  if (!status?.queryable) {
    logger.warn('[dataLakeVectorIndexKeepWarm] vector index is not queryable', { model, status: status?.status });
    return { status: 'skipped', reason: 'not-queryable' };
  }

  const startedAt = Date.now();
  const warmed = await fabFileChunkRepository.warmVectorIndex(model);
  if (!warmed) return { status: 'skipped', reason: 'no-index' };
  const result = { status: 'warmed' as const, model, hits: warmed.hits, durationMs: Date.now() - startedAt };
  // durationMs is the cold/warm signal: a large value means the index had already gone cold.
  logger.info('[dataLakeVectorIndexKeepWarm] warmed', result);
  return result;
}

export const handler = async () => {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  return runDataLakeVectorIndexKeepWarm();
};
