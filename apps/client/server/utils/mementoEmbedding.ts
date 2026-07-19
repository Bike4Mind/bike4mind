import { EmbeddingFactory, getProviderFromModel } from '@bike4mind/fab-pipeline';
import { IAdminSettingsRepository, isSupportedEmbeddingModel, SupportedEmbeddingModel } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

/** Effective provider keys / Ollama base URL for the embedding provider. */
interface MementoEmbeddingApiKeys {
  openai?: string | null;
  voyageai?: string | null;
  ollama?: string | null;
}

interface MementoEmbeddingDeps {
  adminSettings: Pick<IAdminSettingsRepository, 'getSettingsValue'>;
  apiKeyTable: MementoEmbeddingApiKeys | null | undefined;
  logger?: Pick<Logger, 'warn'>;
}

/**
 * Embed a memento summary with the admin-configured Default Embedding Model.
 *
 * Shared by BOTH memento creation paths - the auto path (events/createMemento.ts, on
 * completion.completed) and the manual create endpoint (pages/api/mementos/create.ts) -
 * so they embed identically. Returns null (never throws) when embedding can't run: no
 * model configured, the provider's key/base URL is missing, or the provider errors. The
 * memento is then created without an embedding rather than failing - graceful degradation.
 */
export async function generateMementoSummaryEmbedding(
  summary: string,
  { adminSettings, apiKeyTable, logger }: MementoEmbeddingDeps
): Promise<number[] | null> {
  const defaultEmbeddingModel = await adminSettings.getSettingsValue('defaultEmbeddingModel');
  if (
    !defaultEmbeddingModel ||
    typeof defaultEmbeddingModel !== 'string' ||
    !isSupportedEmbeddingModel(defaultEmbeddingModel)
  ) {
    logger?.warn('Memento embedding skipped: default embedding model not configured');
    return null;
  }

  const provider = getProviderFromModel(defaultEmbeddingModel);
  const embeddingConfig: { openaiApiKey?: string | null; voyageApiKey?: string | null; ollamaBaseUrl?: string | null } =
    {};

  if (provider === 'openai') {
    if (!apiKeyTable?.openai) {
      logger?.warn('Memento embedding skipped: OpenAI API key not found');
      return null;
    }
    embeddingConfig.openaiApiKey = apiKeyTable.openai;
  } else if (provider === 'voyageai') {
    if (!apiKeyTable?.voyageai) {
      logger?.warn('Memento embedding skipped: VoyageAI API key not found');
      return null;
    }
    embeddingConfig.voyageApiKey = apiKeyTable.voyageai;
  } else if (provider === 'ollama') {
    // apiKeyTable.ollama carries the Ollama base URL (no secret) in self-host.
    if (!apiKeyTable?.ollama) {
      logger?.warn('Memento embedding skipped: Ollama base URL not found');
      return null;
    }
    embeddingConfig.ollamaBaseUrl = apiKeyTable.ollama;
  }
  // Bedrock uses AWS credentials, no key needed.

  try {
    const embeddingService = new EmbeddingFactory(embeddingConfig).createEmbeddingService(
      defaultEmbeddingModel as SupportedEmbeddingModel
    );
    return await embeddingService.generateEmbedding(summary);
  } catch (error) {
    logger?.warn('Memento embedding failed; creating memento without an embedding', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
