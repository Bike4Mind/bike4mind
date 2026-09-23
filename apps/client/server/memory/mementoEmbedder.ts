import { MEMENTO_EMBEDDING_MODEL, toMementoVector } from '@bike4mind/common';
import { EmbeddingFactory, getProviderFromModel, resolveEmbeddingConfig } from '@bike4mind/fab-pipeline';
import type { Logger } from '@bike4mind/observability';

/** Embeds text into the ledger's own vector space, or resolves undefined when it cannot. */
export type MementoEmbedder = (text: string) => Promise<number[] | undefined>;

/** The effective LLM key table, as `apiKeyService.getEffectiveLLMApiKeys` returns it. */
type ApiKeyTable = Parameters<typeof resolveEmbeddingConfig>[1];

/**
 * Build an embedder for the MEMENTO space, pinned to `MEMENTO_EMBEDDING_MODEL`.
 *
 * Shared by the ledger's writers (`extractLakeMemory`, `recordFindingResolutionBelief`) rather than
 * inlined at each, because the pin is the whole point: a vector written in a different space is not
 * comparable to the ones recall scores against, and the cosine floor calibrated for this space
 * rejects it silently rather than erroring. One place to get the space right, so a second writer
 * cannot get it wrong.
 *
 * Takes the key table rather than resolving one, because both callers already hold it for other
 * work - `extractLakeMemory` passes the same table to the extraction service - and a helper that
 * fetched its own would double that read.
 *
 * NEVER THROWS, and the caller is expected to carry on without a vector: with no usable provider key
 * this returns an embedder that resolves undefined for every call. A vectorless event is still
 * recallable - `embeddingScorer` falls back to the lexical scorer and flags the result off-scale so
 * the cosine floor cannot drop it (`b4m-core/memory/src/recall.ts:77-82`) - it just ranks on a weaker
 * signal. Worth knowing that it stays that way for a lake: the re-embed backfill walks `user`
 * principals only (`reembedMementos.ts:222`).
 */
export function createMementoEmbedder(apiKeyTable: ApiKeyTable, logger: Logger): MementoEmbedder {
  const provider = getProviderFromModel(MEMENTO_EMBEDDING_MODEL);
  const { config, missing } = resolveEmbeddingConfig(provider, apiKeyTable);
  if (missing) {
    logger.warn(`[lakeMemory] no ${provider} key for ${MEMENTO_EMBEDDING_MODEL}; writing facts without vectors`);
    return async () => undefined;
  }
  const svc = new EmbeddingFactory(config).createEmbeddingService(MEMENTO_EMBEDDING_MODEL);
  return async text => toMementoVector(await svc.generateEmbedding(text));
}
