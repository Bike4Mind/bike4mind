import { dataLakeRepository, memoryLedgerRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { shredMemoryFromSource } from '@server/memory/ledgerMemoryStore';

/**
 * Crypto-shred every fact a purged document contributed, across EVERY lake that extracted it -
 * not just the lake the purge was authorized through. Extraction (`extractLakeMemory`) runs per
 * lake, so a file that is a member of two lakes produces beliefs on both ledgers under the same
 * `fabFileId`; shredding only the authorizing lake's ledger left the other lake folding - and
 * `recallLakeMemory` injecting - beliefs sourced from a document already destroyed.
 *
 * Mirrors `recomputeStatsForLakeTags`: resolve each `datalake:*` meta-tag the file carried to its
 * lake and act on every one, independently and best-effort, so one unresolvable or unwired lake
 * cannot skip the rest. Best-effort means a failure on one lake is caught and logged, not
 * rethrown - unlike the adapter docstring's default "a throw propagates", the destruction has
 * already converged and the receipt is already filed by the time this runs, and per-lake
 * isolation across an unbounded fan-out requires the catch to live here rather than at the call site.
 */
export const shredMemoryForLakeTags = async (
  tagNames: readonly unknown[],
  fabFileId: string,
  {
    logger,
  }: {
    logger: {
      info: (msg: string, meta?: Record<string, unknown>) => void;
      error: (msg: string, meta?: Record<string, unknown>) => void;
    };
  }
): Promise<void> => {
  await Promise.all(
    dataLakeService.extractDataLakeMetaTags(tagNames).map(async metaTag => {
      try {
        const lake = await dataLakeRepository.findByDatalakeTag(metaTag);
        // An orphaned meta-tag left behind by a deleted lake has no ledger left to shred.
        if (!lake?.datalakeTag || !lake.createdByUserId) return;

        const shredded = await shredMemoryFromSource(
          memoryLedgerRepository,
          { kind: 'lake', id: lake.datalakeTag },
          lake.createdByUserId,
          fabFileId
        );
        logger.info('[lakeMemory] shredded the facts extracted from a purged lake document', {
          datalakeTag: lake.datalakeTag,
          fabFileId,
          shredded,
        });
      } catch (error) {
        logger.error('[lakeMemory] failed to shred a purged document facts on one lake', {
          error: error instanceof Error ? error.message : 'Unknown error',
          metaTag,
          fabFileId,
        });
      }
    })
  );
};
