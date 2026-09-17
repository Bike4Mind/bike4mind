import {
  IAdminSettingsRepository,
  IApiKeyRepository,
  MEMENTO_EMBEDDING_ID,
  MEMENTO_EMBEDDING_MODEL,
  toMementoVector,
} from '@bike4mind/common';
import { EmbeddingFactory, getProviderFromModel, getSettingsByNames, resolveEmbeddingConfig } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { getEffectiveLLMApiKeys } from '../apiKeyService';

export interface EmbedMementoQueryAdapters {
  db: {
    apiKeys: Pick<IApiKeyRepository, 'findByUserIdAndTypes' | 'findByUserIdAndType'>;
    adminSettings: IAdminSettingsRepository;
  };
}

/**
 * Embed a query in the SAME vector space the mementos/ledger beliefs were written in -
 * MEMENTO_EMBEDDING_MODEL, which the memory write path pins and stamps. Cosine between vectors from
 * different models is meaningless, so any recall against memento-space data MUST embed the query
 * here, in lockstep with `createMemento` / `writeFactToLedger`.
 *
 * The memento space is its OWN corpus, independent of the admin `defaultEmbeddingModel` that governs
 * FAB chunk vectors.
 *
 * Keyed on the READING user's provider keys (the memento space is deployment-wide, so any user's key
 * for that provider works). Returns an empty vector on any failure (no key, provider error) rather
 * than throwing - the caller then fails open (V1 returns no mementos, V2 falls back to the lexical
 * scorer) rather than breaking the turn.
 *
 * Core-side counterpart of `apps/client/server/memory/mementoQueryEmbedding.ts`, which wraps this
 * with the app's concrete repositories. Kept as separate files because `getRelevantMementos` (this
 * package) cannot depend on `apps/client`, and the app-side wrapper is what `recallMementosV2` /
 * `recallLakeMemory` already import - moving the logic here without breaking that import required a
 * thin re-export rather than relocating the file wholesale.
 */
export async function embedMementoQuery(
  userId: string,
  query: string,
  adapters: EmbedMementoQueryAdapters,
  options?: { logger?: Logger }
): Promise<{ vector: number[]; model: string }> {
  const none = { vector: [] as number[], model: '' };
  if (!query.trim()) return none;

  const apiKeyTable = await getEffectiveLLMApiKeys(
    userId,
    {
      db: {
        apiKeys: adapters.db.apiKeys,
        adminSettings: adapters.db.adminSettings,
      },
      getSettingsByNames,
    },
    { logger: options?.logger }
  );

  const provider = getProviderFromModel(MEMENTO_EMBEDDING_MODEL);
  const { config, missing } = resolveEmbeddingConfig(provider, apiKeyTable);
  if (missing) return none;

  const embeddingService = new EmbeddingFactory(config).createEmbeddingService(MEMENTO_EMBEDDING_MODEL);
  return { vector: toMementoVector(await embeddingService.generateEmbedding(query)), model: MEMENTO_EMBEDDING_ID };
}
