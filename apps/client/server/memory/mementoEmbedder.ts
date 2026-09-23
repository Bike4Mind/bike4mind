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
 * Shared by the two LAKE writers (`extractLakeMemory`, `recordFindingResolutionBelief`) rather than
 * inlined at each, because the pin is the whole point: a vector written in a different space is not
 * comparable to the ones recall scores against, and the cosine floor calibrated for this space
 * rejects it silently rather than erroring.
 *
 * NOT the single place the space is pinned, though it is for those two: `reembedMementos.ts:41-51`
 * resolves the same provider and builds the same factory independently, because it re-encodes into
 * the space rather than writing into it. Changing `MEMENTO_EMBEDDING_MODEL` means checking both.
 *
 * Takes the key table rather than resolving one so the read stays the CALLER's to place.
 * `extractLakeMemory` already holds a table it passes to the extraction service, and resolving a
 * second one here would double that read; `recordFindingResolutionBelief` fetches a table solely to
 * call this, and pays for it on the request path where the cost is visible rather than buried in a
 * helper. Same reason either way: this helper owns the embedding SPACE, not the key lookup.
 *
 * NEVER THROWS, and the caller is expected to carry on without a vector: with no usable provider key
 * this returns an embedder that resolves undefined for every call. A vectorless event is still
 * recallable - `embeddingScorer` falls back to the lexical scorer and flags the result off-scale so
 * the cosine floor cannot drop it (`b4m-core/memory/src/recall.ts:77-82`) - it just ranks on a weaker
 * signal. And it stays that way: nothing backfills a vector onto an event written without one.
 * `reembedMementos.ts` re-encodes EXISTING vectors into a new space and skips vectorless events
 * outright (`reembedMementos.ts:180`).
 */
export function createMementoEmbedder(apiKeyTable: ApiKeyTable, logger: Logger): MementoEmbedder {
  const provider = getProviderFromModel(MEMENTO_EMBEDDING_MODEL);
  const { config, missing } = resolveEmbeddingConfig(provider, apiKeyTable);
  if (missing) {
    logger.warn(`[Mementos V2] no ${provider} key for ${MEMENTO_EMBEDDING_MODEL}; writing facts without vectors`);
    return async () => undefined;
  }
  const svc = new EmbeddingFactory(config).createEmbeddingService(MEMENTO_EMBEDDING_MODEL);
  return async text => toMementoVector(await svc.generateEmbedding(text));
}
