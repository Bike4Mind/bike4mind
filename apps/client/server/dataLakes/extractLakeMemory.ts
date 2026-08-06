import {
  adminSettingsRepository,
  apiKeyRepository,
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
} from '@bike4mind/database';
import { MEMENTO_EMBEDDING_MODEL, toMementoVector } from '@bike4mind/common';
import { apiKeyService, dataLakeService, LakeMemoryExtractionService } from '@bike4mind/services';
import { EmbeddingFactory, getProviderFromModel, resolveEmbeddingConfig } from '@bike4mind/fab-pipeline';
import { getSettingsByNames } from '@bike4mind/utils';
import type { EvidenceTier } from '@bike4mind/memory';
import type { Logger } from '@bike4mind/observability';
import { appendFactToLedger } from '@server/memory/mementoLedgerMirror';

/**
 * Reserved curator-tag markers that promote a lake document's facts to the `human-reviewed` tier. A
 * tag matches when its (lowercased) name IS the marker or ends with `:<marker>` (so both a bare
 * `reviewed` tag and a namespaced `acme:status:reviewed` count). Everything else is `external-facing` -
 * a real, published fact, but one no human curator has vouched for.
 */
const CURATOR_REVIEWED_MARKERS = ['reviewed', 'authoritative'] as const;

/**
 * The evidence tier for a lake document's extracted facts, from its curator tags. Per-DOCUMENT (the
 * eval's tier-collapse was assigning one tier to a whole lake); beliefs inherit their source doc's
 * tier. Pure and total.
 */
export function evidenceTierForDoc(tagNames: string[]): EvidenceTier {
  const reviewed = tagNames.some(raw => {
    const name = raw.toLowerCase();
    return CURATOR_REVIEWED_MARKERS.some(marker => name === marker || name.endsWith(`:${marker}`));
  });
  return reviewed ? 'human-reviewed' : 'external-facing';
}

/** Cap the text sent to the extractor per document, so one huge file cannot dominate the LLM budget. */
const MAX_DOC_CHARS = 24_000;
/** Safety cap on documents scanned in a single extraction run. */
const MAX_DOCS_PER_RUN = 500;
/** Chunk page size when reconstructing a document's text. */
const CHUNK_PAGE_LIMIT = 1_000;

/**
 * Fold a data lake's documents into its memory profile (#1440 producer): enumerate the lake's live
 * docs, extract durable facts from each with an LLM, and append them to the `{ kind: 'lake' }` ledger
 * owned by the lake's creator. Runs on ingest-finalize (a sibling of the taxonomy job) and is idempotent
 * by construction: `appendFactToLedger` semantically de-dups against the lake's own ledger, so a
 * re-scan re-asserts an existing fact under its subject (a fresh presentation that keeps it hot) rather
 * than duplicating it. That is what makes a full-lake re-scan on each finalize SAFE - correctness does
 * not depend on batch-scoping the docs (a per-batch incremental scan is a later cost optimization).
 *
 * Best-effort throughout: a doc that will not read or extract simply contributes no beliefs. Embeddings
 * are best-effort too - a vectorless write stays lexically recallable and can be re-embedded later.
 */
export async function extractLakeMemoryForBatch(
  params: { dataLakeId: string },
  logger: Logger
): Promise<{ docsProcessed: number; factsWritten: number }> {
  const lake = await dataLakeRepository.findById(params.dataLakeId);
  if (!lake?.createdByUserId || !lake.datalakeTag) {
    logger.warn('[lakeMemory] lake missing owner or tag; skipping extraction', { dataLakeId: params.dataLakeId });
    return { docsProcessed: 0, factsWritten: 0 };
  }
  const ownerUserId = lake.createdByUserId;
  const datalakeTag = lake.datalakeTag;

  const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(
    ownerUserId,
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames },
    { logger }
  );

  // Embed each fact in the MEMENTO space (the ledger's own corpus, pinned to MEMENTO_EMBEDDING_MODEL).
  // Best-effort: with no key we write facts WITHOUT a vector - they stay lexically recallable and the
  // re-embed backfill vectorizes them once a key is present (mirrors createMemento's V2 write).
  let embed: (text: string) => Promise<number[] | undefined> = async () => undefined;
  const provider = getProviderFromModel(MEMENTO_EMBEDDING_MODEL);
  const { config, missing } = resolveEmbeddingConfig(provider, apiKeyTable);
  if (missing) {
    logger.warn(`[lakeMemory] no ${provider} key for ${MEMENTO_EMBEDDING_MODEL}; writing facts without vectors`);
  } else {
    const svc = new EmbeddingFactory(config).createEmbeddingService(MEMENTO_EMBEDDING_MODEL);
    embed = async text => toMementoVector(await svc.generateEmbedding(text));
  }

  const extractor = new LakeMemoryExtractionService(logger);
  const docIds = (await fabFileRepository.findIdsByDataLakeTag(dataLakeService.lakeMembershipScope(lake))).slice(
    0,
    MAX_DOCS_PER_RUN
  );

  let docsProcessed = 0;
  let factsWritten = 0;
  for (const docId of docIds) {
    const file = await fabFileRepository.findById(docId);
    // Only LIVE docs contribute - a deleted/archived doc is not citable, so its facts would be dropped
    // by the consumer's reachability gate anyway (findIdsByDataLakeTag includes soft-deleted).
    if (!file || file.deletedAt || file.archivedAt) continue;

    const chunks = await fabFileChunkRepository.findTextsByFabFileId(docId, { limit: CHUNK_PAGE_LIMIT });
    const text = chunks
      .map(c => c.text)
      .join('\n')
      .slice(0, MAX_DOC_CHARS);
    if (!text.trim()) continue;

    docsProcessed++;
    const facts = await extractor.evaluate({
      apiKeyTable,
      docTitle: file.fileName,
      docText: text,
      endUserId: ownerUserId,
    });
    if (!facts?.length) continue;

    const tier = evidenceTierForDoc((file.tags ?? []).map(t => t.name));
    for (const { fact } of facts) {
      const embedding = await embed(fact).catch(() => undefined);
      await appendFactToLedger({
        principal: { kind: 'lake', id: datalakeTag },
        ownerUserId,
        summary: fact,
        evidenceTier: tier,
        sources: [docId],
        embedding,
      });
      factsWritten++;
    }
  }

  logger.info('[lakeMemory] extraction complete', { dataLakeId: params.dataLakeId, docsProcessed, factsWritten });
  return { docsProcessed, factsWritten };
}
