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
import { createLedgerAppendSession } from '@server/memory/mementoLedgerMirror';

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
 * Bound on LIVE documents per run, sized to clear the internal eval corpus (47 docs). The cap applies
 * AFTER tombstones are filtered, so it bounds real work rather than tombstones. A lake larger than this
 * extracts its first slice and defers the rest to a CONTINUATION run: the run persists a keyset cursor
 * (the last doc it attempted) and the handler re-enqueues, so chained runs cover the whole lake instead
 * of the remainder being dropped.
 *
 * This cap is NOT by itself timeout-safe, and an earlier version of this comment claiming ~2-5s per
 * document was measured optimistically. A real preview run took **8.8s for a single document** - one
 * LLM extraction plus 12 facts, each costing an embed round trip and a ledger append whose profile read
 * grows as the run proceeds. At that rate 100 docs is ~15 minutes against a 10-minute Lambda
 * (infra/queues.ts). That measurement includes cold start and hit LAKE_FACTS_PER_DOC_MAX exactly, so it
 * is a high-side sample - but the honest reading is that the cap is an estimate that can be wrong in
 * the expensive direction.
 *
 * What actually keeps a run inside the Lambda is LAKE_EXTRACTION_DEADLINE_BUFFER_MS below. Treat this
 * number as "how much work we are willing to queue up", and the deadline as the thing that enforces it.
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
/**
 * How long a per-lake extraction lease is honored before another run may reclaim it. Longer than the
 * Lambda's own 10-minute timeout (infra/queues.ts), so a healthy in-flight run is never stolen; short
 * enough that a crashed run (which never released its lease) is reclaimable on the next finalize without
 * a reconciler. A continuation chain runs as separate invocations that each claim + release their own
 * lease, so this only has to cover ONE slice, not the whole chain.
 */
const LAKE_MEMORY_EXTRACTION_LEASE_MS = 15 * 60_000;
/** Chunk page size when reconstructing a document's text. */
const CHUNK_PAGE_LIMIT = 1_000;

/**
 * Fold a data lake's documents into its memory profile (#1440 producer): enumerate the lake's live
 * docs, extract durable facts from each with an LLM, and append them to the `{ kind: 'lake' }` ledger
 * owned by the lake's creator. Runs on ingest-finalize (a sibling of the taxonomy job) and is idempotent
 * by construction: the ledger append session (`createLedgerAppendSession`) semantically de-dups
 * against the lake's own ledger, so a re-scan re-asserts an existing fact under its subject (a fresh
 * presentation that keeps it hot) rather than duplicating it. That is what makes a full-lake re-scan
 * on each finalize SAFE - correctness does not depend on batch-scoping the docs (a per-batch
 * incremental scan is a later cost optimization).
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
): Promise<{ docsProcessed: number; factsWritten: number; hasMore: boolean }> {
  const startedAt = Date.now();
  // `?? ` alone would not be enough: a non-finite reading (NaN, Infinity) is not nullish, and every
  // comparison against it is false - which would disable the guard silently rather than fall back.
  const remainingMs = () => {
    const reported = params.getRemainingTimeInMillis?.();
    return typeof reported === 'number' && Number.isFinite(reported)
      ? reported
      : DEFAULT_RUN_BUDGET_MS - (Date.now() - startedAt);
  };
  const lake = await dataLakeRepository.findById(params.dataLakeId);
  if (!lake?.createdByUserId || !lake.datalakeTag) {
    logger.warn('[lakeMemory] lake missing owner or tag; skipping extraction', { dataLakeId: params.dataLakeId });
    return { docsProcessed: 0, factsWritten: 0, hasMore: false };
  }
  const ownerUserId = lake.createdByUserId;
  const datalakeTag = lake.datalakeTag;

  // Per-lake concurrency guard: two near-simultaneous batch finalizes would otherwise each run a full,
  // LLM-billed extraction of the same lake. Claim a LEASE (not a status) so a crashed run frees itself
  // after LAKE_MEMORY_EXTRACTION_LEASE_MS without a reconciler.
  const claimedAt = new Date();
  const staleBefore = new Date(claimedAt.getTime() - LAKE_MEMORY_EXTRACTION_LEASE_MS);
  const claimed = await dataLakeRepository.claimLakeMemoryExtraction(lake.id, claimedAt, staleBefore);
  if (!claimed) {
    logger.info('[lakeMemory] another run holds the extraction lease for this lake; skipping duplicate run', {
      dataLakeId: params.dataLakeId,
    });
    return { docsProcessed: 0, factsWritten: 0, hasMore: false };
  }

  try {
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
    // Drop tombstones BEFORE applying the cap, and sort by id so the continuation cursor is a stable
    // keyset boundary. `findIdsByDataLakeTag` includes soft-deleted/archived ids (it must, for
    // lifecycle), so filtering first keeps tombstones from consuming cap slots and pushing live docs out
    // (a lake of 40 tombstones + 10 live would otherwise fold nothing). FabFile ids are ObjectId hex,
    // whose lexicographic order is creation order, so a new upload sorts AFTER the cursor and is picked
    // up on a later run rather than shifting the window under an in-progress scan.
    const liveDocs = (await fabFileRepository.findAllByIds(allDocIds))
      .filter(f => !f.deletedAt && !f.archivedAt)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    // Bounded continuation: resume AFTER the last document a prior interrupted run attempted (the
    // persisted cursor), not from the cap boundary - the deadline guard can end a run mid-slice, so the
    // cap is not the only place a run stops. Absent cursor = start from the beginning.
    const cursor = lake.lakeMemoryCursor ?? null;
    const remainingDocs = cursor ? liveDocs.filter(f => f.id > cursor) : liveDocs;
    const docs = remainingDocs.slice(0, MAX_DOCS_PER_RUN);
    if (remainingDocs.length > docs.length) {
      logger.info(
        `[lakeMemory] lake ${datalakeTag}: ${remainingDocs.length} docs remain this scan, extracting ` +
          `${docs.length} now; a continuation run will cover the rest`
      );
    }

    // One de-dup session for the whole run: reads the lake's profile ONCE instead of re-decrypting the
    // append-only chain per fact (which grows quadratically as the run's own writes lengthen it).
    const session = await createLedgerAppendSession({
      principal: { kind: 'lake', id: datalakeTag },
      ownerUserId,
    });

    let docsProcessed = 0;
    let factsWritten = 0;
    let docsAttempted = 0;
    let lastAttemptedId: string | null = null;
    for (const file of docs) {
      // Yield rather than get killed. Checked BEFORE starting a doc, since the expensive, unresumable
      // part (the LLM call) is at the start of one. Unlike before, the uncovered docs are NOT lost: the
      // cursor bookkeeping below persists progress and a continuation run picks them up.
      if (remainingMs() < LAKE_EXTRACTION_DEADLINE_BUFFER_MS) {
        logger.warn(
          `[lakeMemory] lake ${datalakeTag} ran out of time after ${docsAttempted}/${docs.length} docs; ` +
            `${docs.length - docsAttempted} not extracted this run. Beliefs already written are kept; stopping ` +
            `here avoids a redelivery re-billing the whole lake, and a continuation run covers the rest.`
        );
        break;
      }
      docsAttempted++;
      lastAttemptedId = file.id;
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
          await session.append({ summary: fact, evidenceTier: tier, sources: [file.id], embedding });
          factsWritten++;
        }
      } catch (err) {
        // One bad document must not abort the whole lake. Without this, a doc that reliably throws in
        // extractor.evaluate aborts the run, SQS redelivers, every earlier doc is re-billed (the LLM call
        // precedes the ledger de-dup), it throws again, and the run DLQs - docs after it never fold. Skip
        // + log so the rest of the lake still folds; a re-scan retries the bad doc.
        logger.warn(
          `[lakeMemory] doc ${file.id} failed; skipping it this run: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Continuation bookkeeping. `uncovered` counts docs in THIS scan not yet attempted, whether the run
    // stopped at the cap or the deadline.
    const uncovered = remainingDocs.length - docsAttempted;
    let hasMore = false;
    if (docsAttempted > 0 && uncovered > 0 && lastAttemptedId) {
      try {
        // Resume from what was ATTEMPTED, not the cap: persist the last attempted id as the cursor.
        await dataLakeRepository.setLakeMemoryCursor(lake.id, lastAttemptedId);
        hasMore = true; // only ask for a continuation once progress is durably recorded
      } catch (err) {
        // Gate hasMore on the cursor actually landing. If it will not persist, a re-enqueued
        // continuation would read the un-advanced cursor, redo this slice and re-bill it - and a
        // persistent failure would loop. Leave the remainder to the next batch finalize, which re-scans
        // from the top; failing loudly here rather than papering over it.
        logger.warn(
          `[lakeMemory] lake ${datalakeTag} could not persist the continuation cursor; the remaining ` +
            `${uncovered} doc(s) will be picked up on the next finalize: ${
              err instanceof Error ? err.message : String(err)
            }`
        );
      }
    } else if (uncovered === 0) {
      // Whole scan covered. Clear the cursor so the next batch finalize does a fresh full re-scan, which
      // re-asserts existing facts and keeps their ACT-R salience hot (the idempotency contract above).
      // Best-effort: a failed clear self-heals - the next run resumes from a cursor past the last doc,
      // finds nothing uncovered, and clears it again.
      if (cursor) {
        await dataLakeRepository
          .setLakeMemoryCursor(lake.id, null)
          .catch(err =>
            logger.warn(
              `[lakeMemory] lake ${datalakeTag} could not clear the continuation cursor: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          );
      }
    } else {
      // uncovered > 0 but nothing attempted: the deadline hit before the first doc. Advancing the cursor
      // or re-enqueuing here would be a no-progress loop, so do neither - the next finalize retries.
      logger.warn(
        `[lakeMemory] lake ${datalakeTag} made no progress before the deadline; ${uncovered} doc(s) still ` +
          `uncovered, not enqueuing a continuation (would loop)`
      );
    }

    logger.info('[lakeMemory] extraction complete', {
      dataLakeId: params.dataLakeId,
      docsProcessed,
      factsWritten,
      // `docsAttempted < docs.length` is the deadline-stop signal; `hasMore` is whether a continuation
      // was enqueued (cap or deadline left docs uncovered and we made progress).
      docsAttempted,
      docsAvailableThisRun: docs.length,
      hasMore,
      elapsedMs: Date.now() - startedAt,
    });
    return { docsProcessed, factsWritten, hasMore };
  } finally {
    // Compare-and-clear so a stale takeover's lease is not cleared by our late finish. Best-effort: a
    // failed release just leaves the lease to expire on its own after the window.
    await dataLakeRepository
      .releaseLakeMemoryExtraction(lake.id, claimedAt)
      .catch(err =>
        logger.warn(
          `[lakeMemory] failed to release extraction lease for ${datalakeTag}: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      );
  }
}
