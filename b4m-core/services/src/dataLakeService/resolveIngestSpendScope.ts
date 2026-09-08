import type { IDataLakeBatchRepository, IDataLakeRepository } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { findMemberLakesForFile, type ChunkPolicyFile } from './chunkPolicyConflict';
import { extractDataLakeMetaTags, isStaticRegistryDatalakeTag } from './authorizeLakeWrite';

/** The file facts the scope is derived from. `batchId` is present only for a lake-batch upload. */
export type IngestSpendScopeFile = ChunkPolicyFile & { batchId?: string | null };

export interface IngestSpendScopeDb {
  dataLakeBatches: Pick<IDataLakeBatchRepository, 'findById'>;
  dataLakes: Pick<IDataLakeRepository, 'find' | 'findByDatalakeTag'>;
}

/** What the spend gate needs to meter a call: the run and lake it should be charged against. */
export interface IngestSpendScope {
  batchId?: string;
  dataLakeId?: string;
}

/**
 * Decide whether a vectorize run is DATA-LAKE work, and which run/lake it belongs to.
 *
 * The distinction this exists to fix: `batchId` records how a file ARRIVED, not what it belongs
 * to. It is stamped from the S3 upload metadata of a lake-batch upload and nothing backfills it,
 * so a file tagged into a lake afterwards - and every member of a static-registry lake - carries
 * none. Membership, by contrast, is what the bulk doors select on: both Rebuild Passages and
 * convergence enumerate members by tag scope. Keying the spend gate on `batchId` alone therefore
 * let exactly those members re-embed with no throughput cap and no budget.
 *
 * Returns null for a file that is not lake work at all, which is the common case for a personal
 * upload. That case costs ZERO reads against the lakes collection: findMemberLakesForFile only
 * queries when the file carries a tag that could be a membership signal.
 *
 * STATIC-REGISTRY lakes are lake work with NO `dataLakeId`. They have no lake document, which is
 * why findMemberLakesForFile drops their meta-tags - a filter that exists there so a documentless
 * lake cannot be asked to declare a chunk policy, and which would silently read as "not lake work"
 * here. But Rebuild Passages does run over them (assertLakeRebuildAccess is deliberately the one
 * file-level lake write that needs no lake document), and their members are stamped with the
 * meta-tag and no batchId, so this is precisely the bulk-door-over-tagged-population case the
 * throughput cap exists for. Returning an empty scope puts those calls under the platform-wide
 * throughput and period windows while leaving the run and lake meters alone - correct rather than
 * merely convenient, since neither has anywhere to write for a lake that does not exist.
 *
 * Deliberately does NOT catch a failed lakes read. An unreadable membership is UNKNOWN, and
 * treating unknown as "not lake work" would route the call around the throughput cap and every
 * budget - the exact bypass this function exists to close, now triggered by an outage instead of
 * by a missing field. The throw fails the vectorize message, which SQS redelivers.
 *
 * Attribution when a file belongs to SEVERAL lakes: the lowest lake id, chosen because it is
 * stable across SQS redeliveries of the same message (an arbitrary-but-varying pick would meter
 * a redelivery against a different lake than the reservation it is retrying). One re-embed of a
 * shared file is charged to one of its lakes rather than split, which under-reports the others -
 * accepted, because the alternative of attributing to none puts the multi-lake files, the most
 * expensive ones, back outside every budget.
 */
export async function resolveIngestSpendScope(
  file: IngestSpendScopeFile,
  db: IngestSpendScopeDb,
  logger?: Logger
): Promise<IngestSpendScope | null> {
  if (file.batchId) {
    const batch = await db.dataLakeBatches.findById(file.batchId);
    return { batchId: file.batchId, dataLakeId: batch?.dataLakeId };
  }

  const memberLakes = await findMemberLakesForFile(file, db.dataLakes);
  if (memberLakes.length === 0) {
    // No DB-backed lake. Before calling this "not lake work", check the one membership signal
    // findMemberLakesForFile is built to discard (see the doc comment above).
    const tagNames = (file.tags ?? []).map(t => t?.name);
    const staticTags = extractDataLakeMetaTags(tagNames).filter(isStaticRegistryDatalakeTag);
    if (staticTags.length > 0) {
      logger?.log?.(
        `[spendGate] file ${file.id} is a static-registry lake member (${staticTags[0]}); metering platform windows only`
      );
      return {};
    }
    return null;
  }

  const [dataLakeId] = memberLakes.map(lake => lake.id).sort();
  if (memberLakes.length > 1) {
    logger?.log?.(`[spendGate] file ${file.id} belongs to ${memberLakes.length} lakes; metering against ${dataLakeId}`);
  }
  return { dataLakeId };
}
