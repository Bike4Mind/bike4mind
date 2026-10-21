import { EmbeddingFactory, getProviderFromModel, resolveEmbeddingConfig } from '@bike4mind/fab-pipeline';
import { MEMENTO_EMBEDDING_MODEL, toMementoVector } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

/** Effective provider keys / Ollama base URL for the embedding provider. */
interface MementoEmbeddingApiKeys {
  openai?: string | null;
  voyageai?: string | null;
  ollama?: string | null;
}

interface MementoEmbeddingDeps {
  apiKeyTable: MementoEmbeddingApiKeys | null | undefined;
  logger?: Pick<Logger, 'warn'>;
}

/**
 * Embed a memento summary in the memento embedding space (`MEMENTO_EMBEDDING_MODEL`, truncated via
 * `toMementoVector`) - the same space `getRelevantMementos` reads against and `writeFactToLedger`
 * writes to. Pinned rather than resolved from the admin `defaultEmbeddingModel`: that setting
 * governs FAB chunk vectors, a separate corpus, and letting it drive this path would put a memento's
 * stored vector in whatever space FAB happens to be in on write day.
 *
 * Shared by BOTH memento creation paths - the auto path (events/createMemento.ts, on
 * completion.completed) and the manual create endpoint (pages/api/mementos/create.ts) -
 * so they embed identically. Returns null (never throws) when embedding can't run: the
 * provider's key/base URL is missing, or the provider errors. The memento is then created
 * without an embedding rather than failing - graceful degradation.
 */
export async function generateMementoSummaryEmbedding(
  summary: string,
  { apiKeyTable, logger }: MementoEmbeddingDeps
): Promise<number[] | null> {
  const provider = getProviderFromModel(MEMENTO_EMBEDDING_MODEL);
  // Keyless providers (Bedrock) report nothing missing and proceed on the AWS credential chain.
  const { config: embeddingConfig, missing } = resolveEmbeddingConfig(provider, apiKeyTable);
  if (missing) {
    logger?.warn(
      `Memento embedding skipped: ${missing === 'ollama' ? 'Ollama base URL' : `${missing === 'openai' ? 'OpenAI' : 'VoyageAI'} API key`} not found`
    );
    return null;
  }

  try {
    const embeddingService = new EmbeddingFactory(embeddingConfig).createEmbeddingService(MEMENTO_EMBEDDING_MODEL);
    return toMementoVector(await embeddingService.generateEmbedding(summary));
  } catch (error) {
    logger?.warn('Memento embedding failed; creating memento without an embedding', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
