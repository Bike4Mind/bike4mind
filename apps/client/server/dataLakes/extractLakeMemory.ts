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
/**
 * Timeout-safe bound on LIVE documents per run. Extraction is sequential and each doc costs one LLM
 * call plus embeds/appends (~2-5s), and the job's Lambda has a 10-minute timeout (infra/queues.ts), so
 * ~100 docs is the ceiling that reliably completes in one pass. Chosen to clear the internal eval
 * corpus (47 docs) with headroom. A lake larger than this extracts its first slice and LOGS the
 * remainder (never a silent drop); full coverage for genuinely large lakes is the bounded-continuation
 * follow-up (a cursor + re-enqueue). The cap applies AFTER tombstones are filtered, so it is a bound on
 * real work, not on tombstones.
 */
const MAX_DOCS_PER_RUN = 100;
/**
 * Stop starting new documents once the Lambda has less than this left, so a run ends by LOGGING its
 * remainder instead of being killed mid-document.
 *
 * The doc cap above is an *estimate* of what fits; this is the *enforcement*. Both are needed, because
 * the per-doc cost is not a constant: one doc is one LLM extraction plus up to `LAKE_FACTS_PER_DOC_MAX`
 * embed round trips and that many ledger appends, and each append re-reads the lake's whole profile - so
 * later documents in a run are slower than earlier ones. Getting killed instead of yielding is
 * expensive rather than merely late: the handler rethrows, SQS redelivers (`retry: 2`, then DLQ), and
 * every redelivery re-bills the entire lake, because the LLM call for a doc precedes the ledger de-dup
 * that would have made it free.
 *
 * Sized for the slowest realistic single document, not the average one.
 */
const LAKE_EXTRACTION_DEADLINE_BUFFER_MS = 90_000;
/**
 * Wall-clock budget when the caller cannot supply the Lambda's real remaining time (tests, scripts, any
 * non-Lambda host). Keeps the guard active by default rather than silently absent - an unbounded default
 * would mean the guard exists only where someone remembered to wire it.
 */
const DEFAULT_RUN_BUDGET_MS = 9 * 60_000;
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
  params: {
    dataLakeId: string;
    /**
     * The Lambda's `context.getRemainingTimeInMillis`. Supplied by the queue handler so the deadline
     * tracks the real invocation (including cold start and time already spent) rather than a guess;
     * omitted callers fall back to `DEFAULT_RUN_BUDGET_MS` from entry.
     */
    getRemainingTimeInMillis?: () => number;
  },
  logger: Logger
): Promise<{ docsProcessed: number; factsWritten: number }> {
  const startedAt = Date.now();
  const remainingMs = () => params.getRemainingTimeInMillis?.() ?? DEFAULT_RUN_BUDGET_MS - (Date.now() - startedAt);
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
  const allDocIds = await fabFileRepository.findIdsByDataLakeTag(dataLakeService.lakeMembershipScope(lake));
  // Fetch the docs and drop tombstones BEFORE applying the cap. `findIdsByDataLakeTag` includes
  // soft-deleted/archived ids (it must, for lifecycle), so slicing first would let tombstones consume
  // cap slots and push live docs out - a lake of 40 tombstones + 10 live would fold nothing. Filtering
  // first also replaces the per-doc findById with one batched read.
  const liveDocs = (await fabFileRepository.findAllByIds(allDocIds)).filter(f => !f.deletedAt && !f.archivedAt);
  const docs = liveDocs.slice(0, MAX_DOCS_PER_RUN);
  if (liveDocs.length > docs.length) {
    // Never silently truncate: a large lake covers only its first slice this run. Surfacing the
    // remainder is what keeps "the card looks complete" from masking a partial extraction.
    logger.warn(
      `[lakeMemory] lake ${datalakeTag} has ${liveDocs.length} live docs; extracting ${docs.length} this run, ` +
        `${liveDocs.length - docs.length} not yet covered (bounded-continuation follow-up)`
    );
  }

  let docsProcessed = 0;
  let factsWritten = 0;
  let docsAttempted = 0;
  for (const file of docs) {
    // Yield rather than get killed. Checked BEFORE starting a doc, since the expensive, unresumable
    // part (the LLM call) is at the start of one.
    if (remainingMs() < LAKE_EXTRACTION_DEADLINE_BUFFER_MS) {
      logger.warn(
        `[lakeMemory] lake ${datalakeTag} ran out of time after ${docsAttempted}/${docs.length} docs; ` +
          `${docs.length - docsAttempted} not yet covered this run (bounded-continuation follow-up). ` +
          `Stopping cleanly so the beliefs already written are kept and the lake is not re-billed by a redelivery.`
      );
      break;
    }
    docsAttempted++;
    try {
      const chunks = await fabFileChunkRepository.findTextsByFabFileId(file.id, { limit: CHUNK_PAGE_LIMIT });
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
          sources: [file.id],
          embedding,
        });
        factsWritten++;
      }
    } catch (err) {
      // One bad document must not abort the whole lake. Without this, a doc that reliably throws in
      // extractor.evaluate aborts the run, SQS redelivers, every earlier doc is re-billed (the LLM call
      // precedes the ledger de-dup), it throws again, and the run DLQs - docs after it never fold. Skip
      // + log so the rest of the lake still folds; the next finalize's re-scan retries the bad doc.
      logger.warn(
        `[lakeMemory] doc ${file.id} failed; skipping it this run: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  logger.info('[lakeMemory] extraction complete', {
    dataLakeId: params.dataLakeId,
    docsProcessed,
    factsWritten,
    // `docsAttempted < docs.length` is the deadline-stop signal, distinct from the cap's own log above.
    docsAttempted,
    docsAvailableThisRun: docs.length,
    elapsedMs: Date.now() - startedAt,
  });
  return { docsProcessed, factsWritten };
}
