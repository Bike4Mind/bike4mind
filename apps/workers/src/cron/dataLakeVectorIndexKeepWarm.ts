/**
 * Keeps the per-model Atlas vector indexes paged in, so the first lake turn after an idle stretch
 * does not pay a cold `$vectorSearch`. Forced retrieval gives its ANN candidate pick 3s
 * (FORCED_RETRIEVAL_ANN_DEADLINE_MS in ChatCompletionFeatures.ts) and falls back to picking the
 * first 100 files by name past it. On production, warm picks finish in 0.15-1.5s, but the first
 * pick after hours idle has overrun every time, and a first query has been seen taking 49s.
 *
 * Every queryable index, not just defaultEmbeddingModel's: a turn queries the model its corpus
 * majority-votes for (resolveMajorityEmbeddingModel), and a lake embedded before the default
 * changed still votes for the old one. An index whose model has no chunks answers immediately.
 * Schedule: rate(5 minutes) on prod and dev (infra/cron.ts dataLakeVectorIndexKeepWarm).
 * No self-host equivalent: self-host retrieval runs on OpenSearch, not Atlas.
 */
import { adminSettingsRepository, connectDB, fabFileChunkRepository } from '@bike4mind/database';
import { atlasVectorIndexModels } from '@bike4mind/fab-pipeline';
import { Logger } from '@bike4mind/observability';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'dataLakeVectorIndexKeepWarm' } });

export type WarmedIndex = { model: string; hits: number; durationMs: number };

export type KeepWarmResult =
  { status: 'skipped'; reason: 'vector-search-off' } | { status: 'ran'; warmed: WarmedIndex[] };

/**
 * Warms the indexes one at a time so the run never stacks parallel 10k-candidate queries on
 * mongot. A failing index does not stop the rest; the run then throws so the Lambda records it.
 */
export async function runDataLakeVectorIndexKeepWarm(): Promise<KeepWarmResult> {
  if ((await adminSettingsRepository.getSettingsValue('EnableDataLakeVectorSearch')) !== true) {
    return { status: 'skipped', reason: 'vector-search-off' };
  }

  const warmed: WarmedIndex[] = [];
  const failures: unknown[] = [];
  for (const model of atlasVectorIndexModels()) {
    try {
      const status = await fabFileChunkRepository.getAtlasIndexStatus(model);
      if (!status?.queryable) continue;
      const startedAt = Date.now();
      const result = await fabFileChunkRepository.warmVectorIndex(model);
      if (result) warmed.push({ model, hits: result.hits, durationMs: Date.now() - startedAt });
    } catch (error) {
      logger.error('[dataLakeVectorIndexKeepWarm] failed to warm index', { model, error });
      failures.push(error);
    }
  }

  // durationMs is the cold/warm signal: a large value means that index had already gone cold.
  logger.info('[dataLakeVectorIndexKeepWarm] run complete', { warmed, failed: failures.length });
  if (failures.length > 0) {
    throw new AggregateError(failures, `[dataLakeVectorIndexKeepWarm] ${failures.length} index(es) failed to warm`);
  }
  return { status: 'ran', warmed };
}

export const handler = async () => {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  return runDataLakeVectorIndexKeepWarm();
};
