import {
  dataLakeRepository,
  dataLakeBatchRepository,
  dataLakeAccessGrantRepository,
  fabFileRepository,
  fabFileChunkRepository,
  memoryLedgerRepository,
  memoryPrincipalKeyRepository,
} from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { FabFileChunkSearchIndex } from '@bike4mind/fab-pipeline';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { shredPrincipalMemory } from '@server/memory/ledgerMemoryStore';
import { createKeyProvider } from '@server/memory/factCipher';
import { BadRequestError } from '@bike4mind/utils';
import { z, ZodError } from 'zod';

const CleanupPayload = z.object({
  dataLakeId: z.string(),
  // administeredOrgIds rides along so the async re-check keeps the org-manageable rung the request
  // path used (optional for back-compat with any message enqueued before this field existed).
  actor: z.object({
    userId: z.string(),
    isAdmin: z.boolean(),
    administeredOrgIds: z.array(z.string()).optional(),
  }),
});

/**
 * Background consumer for the phase-2 data-lake hard-delete sweep, offloaded off the request path
 * (a large lake can blow the request Lambda's timeout). Re-runs the same guarded, idempotent
 * `cleanupDeletedDataLake` service, so a duplicate/stale delivery is safe.
 */
export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  // Hoisted so the catch can name the lake it is releasing. Stays undefined when parsing itself
  // failed, which is exactly the case that has no purge to release.
  let parsedLakeId: string | undefined;
  try {
    // Parse INSIDE the try: a malformed body (bad JSON / wrong shape) is permanently invalid, so
    // it must be swallowed like the other permanent errors below, not retried into the DLQ.
    const { dataLakeId, actor } = CleanupPayload.parse(JSON.parse(event.Records[0].body));
    parsedLakeId = dataLakeId;
    logger.updateMetadata({ handler: 'dataLakeCleanup', dataLakeId, userId: actor.userId });

    await dataLakeService.cleanupDeletedDataLake(actor, dataLakeId, {
      db: {
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        batches: dataLakeBatchRepository,
        fabFiles: fabFileRepository,
        fabFileChunks: fabFileChunkRepository,
      },
      // Undefined everywhere except self-host OpenSearch - Atlas's vector index lives on the
      // FabFileChunk collection itself, so the chunk-sweep two steps below already removes it.
      retrievalIndex: selfHostOpenSearchEnabled()
        ? dataLakeService.openSearchRetrievalIndex({
            db: { fabFileChunks: fabFileChunkRepository },
            searchIndex: FabFileChunkSearchIndex,
          })
        : undefined,
      // Crypto-shred the lake's memory profile as part of the purge (#1440) - destroy the DEK and mark
      // the ledger shredded, so a deleted lake leaves no readable belief ledger behind.
      //
      // LOG IT. This is a data-retention operation, and until it logged, a successful shred and a
      // shred that never ran were indistinguishable from the outside: the port is optional, so a host
      // that failed to wire it would still exit 0 and look identical in CloudWatch. Verified live on a
      // preview - the cleanup Lambda ran clean and emitted nothing, which is exactly the evidence gap
      // this closes. The log is the only artifact that says a given lake's beliefs were destroyed.
      shredMemory: async ({ datalakeTag, ownerUserId }) => {
        await shredPrincipalMemory(
          memoryLedgerRepository,
          createKeyProvider(memoryPrincipalKeyRepository),
          { kind: 'lake', id: datalakeTag },
          ownerUserId
        );
        logger.info('[lakeMemory] crypto-shredded the lake memory profile', { datalakeTag, ownerUserId });
      },
      logger,
    });
  } catch (err) {
    // A failed GUARD (BadRequestError: not a manager, or the lake is not in a sweepable status) is
    // the one permanent failure that abandons an ACCEPTED purge, so it does not get to be a quiet
    // WARN. Log it at ERROR and release 'purging' -> 'deleted', which puts the lake back in the
    // deleted-lakes list where its owner can see it and retry, rather than leaving it in a status
    // no list shows (#1744).
    //
    // Releasing is safe ONLY because cleanupDeletedDataLake throws BadRequestError exclusively from
    // its two entry guards, before anything is destroyed. Keep it that way: a BadRequestError raised
    // deeper in the sweep would make this advertise a half-purged lake as restorable. Every other
    // failure (DB/network) rethrows below and is recovered by DLQ replay, which must NOT release -
    // that lake may be partly swept.
    if (err instanceof BadRequestError) {
      logger.error('[dataLakes] cleanup sweep refused by its own guard; releasing the accepted purge', {
        dataLakeId: parsedLakeId,
        reason: err.message,
      });
      if (parsedLakeId) await dataLakeRepository.releasePurgingToDeleted(parsedLakeId);
      return;
    }
    // Malformed payload (SyntaxError/ZodError): permanently invalid and unattributable - there is no
    // lake id to release, since parsing it is what failed. Retrying cannot fix it, so swallow with a
    // WARN rather than burn retries into the DLQ.
    if (err instanceof ZodError || err instanceof SyntaxError) {
      logger.warn(`Skipping data-lake cleanup message: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    throw err;
  }
});
