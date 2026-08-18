import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { MEMENTO_EMBEDDING_ID, MEMENTO_EMBEDDING_MODEL, toMementoVector } from '@bike4mind/common';
import { EmbeddingFactory, getProviderFromModel, resolveEmbeddingConfig } from '@bike4mind/fab-pipeline';
import { apiKeyService } from '@bike4mind/services';
import { getSettingsByNames } from '@bike4mind/utils';

/**
 * Embed a query in the SAME vector space the mementos/ledger beliefs were written in -
 * MEMENTO_EMBEDDING_MODEL, which the memory write path pins and stamps. Cosine between vectors from
 * different models is meaningless, so any recall against ledger beliefs MUST embed the query here, in
 * lockstep with `writeFactToLedger` / `appendFactToLedger` and `createMemento`.
 *
 * The ledger is its OWN corpus, independent of the admin `defaultEmbeddingModel` that governs FAB
 * chunk vectors - a lake belief's embedding lives in the MEMENTO space, NOT the FabFile chunk space.
 *
 * Keyed on the READING user's provider keys (the memento space is deployment-wide, so any user's key
 * for that provider works). Returns an empty vector on any failure (no key, provider error): the
 * caller then falls back to the lexical scorer rather than breaking the chat.
 *
 * Shared by every memento-space recall (`recallMementosV2`, `recallLakeMemory`) so the query-embed
 * path can never drift between them.
 */
export async function embedMementoQuery(userId: string, query: string): Promise<{ vector: number[]; model: string }> {
  const none = { vector: [] as number[], model: '' };
  if (!query.trim()) return none;

  const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(userId, {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  });

  const provider = getProviderFromModel(MEMENTO_EMBEDDING_MODEL);
  const { config, missing } = resolveEmbeddingConfig(provider, apiKeyTable);
  if (missing) return none;

  const embeddingService = new EmbeddingFactory(config).createEmbeddingService(MEMENTO_EMBEDDING_MODEL);
  return { vector: toMementoVector(await embeddingService.generateEmbedding(query)), model: MEMENTO_EMBEDDING_ID };
}
