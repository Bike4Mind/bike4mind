import { dataLakeRepository, memoryLedgerRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { shredMemoryFromSource } from '@server/memory/ledgerMemoryStore';

/**
 * Crypto-shred every fact a purged document contributed, across EVERY lake it belonged to by
 * EITHER membership arm - not just the lake the purge was authorized through. Extraction
 * (`extractLakeMemory`) runs per lake, so a file that is a member of two lakes produces beliefs on
 * both ledgers under the same `fabFileId`; shredding only the authorizing lake's ledger left the
 * other lake folding - and `recallLakeMemory` injecting - beliefs sourced from a document already
 * destroyed.
 *
 * Resolved through `findMemberLakesForFile`, the same both-arm membership answer chunk-policy
 * conflict detection uses, rather than `recomputeStatsForLakeTags`'s meta-tag-only fan-out: that
 * sibling deliberately skips the prefix arm (blocked on #1263), but that blocker is about
 * resolving a prefix back to ITS lake in general, not about enumerating one file's own member
 * lakes, which is anchored on the owner and needs no prefix-uniqueness guarantee.
 *
 * The purging lake is shredded from `purgingLake` directly rather than resolved back through this
 * lookup: `findMemberLakesForFile`'s meta-tag arm still round-trips through
 * `extractDataLakeMetaTags` (which lowercases) and an exact-match `findByDatalakeTag`, so a lake
 * whose stored `datalakeTag` is not lowercase would otherwise resolve to nothing even though it is
 * the very lake the purge ran through. Deduped against the lookup's results by lake id, so a
 * purging lake that also resolves normally is not shredded (and logged) twice.
 *
 * Best-effort at two granularities. Each RESOLVED lake's shred is caught and logged individually,
 * not rethrown - unlike the adapter docstring's default "a throw propagates", the destruction has
 * already converged and the receipt is already filed by the time this runs, and per-lake isolation
 * across an unbounded fan-out requires the catch to live here rather than at the call site.
 * Resolving the OTHER member lakes is one bulk call (`findMemberLakesForFile` has no per-lake
 * catch of its own), so a single unresolvable meta-tag or a failed prefix-arm query fails that
 * whole lookup rather than just the one lake - caught separately, so it can never cost the purging
 * lake its own shred, which needs no lookup at all.
 */
export const shredMemoryForLakeTags = async (
  tagNames: readonly unknown[],
  fabFileId: string,
  ownerUserId: string,
  purgingLake: { id: string; datalakeTag: string; createdByUserId: string },
  {
    logger,
  }: {
    logger: {
      info: (msg: string, meta?: Record<string, unknown>) => void;
      error: (msg: string, meta?: Record<string, unknown>) => void;
    };
  }
): Promise<void> => {
  const names = tagNames.filter((name): name is string => typeof name === 'string');

  const lakes = new Map<string, { datalakeTag: string; createdByUserId: string }>();
  lakes.set(purgingLake.id, purgingLake);
  try {
    const memberLakes = await dataLakeService.findMemberLakesForFile(
      { id: fabFileId, userId: ownerUserId, tags: names.map(name => ({ name })) },
      dataLakeRepository
    );
    for (const lake of memberLakes) {
      if (!lakes.has(lake.id)) lakes.set(lake.id, lake);
    }
  } catch (error) {
    logger.error("[lakeMemory] failed to resolve the document's other member lakes; shredding only the purging lake", {
      error: error instanceof Error ? error.message : 'Unknown error',
      fabFileId,
    });
  }

  await Promise.all(
    [...lakes.entries()].map(async ([lakeId, lake]) => {
      try {
        if (!lake.datalakeTag || !lake.createdByUserId) return;

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
          lakeId,
          fabFileId,
        });
      }
    })
  );
};
