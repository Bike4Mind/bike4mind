import {
  dataLakeFindingRepository,
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
  orgGoogleDriveConnectionRepository,
  sessionRepository,
  userRepository,
} from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { FabFileChunkSearchIndex } from '@bike4mind/fab-pipeline';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';
import type { IDataLakeDocument } from '@bike4mind/common';
import { Resource } from 'sst';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { releaseDriveConnection } from '@server/integrations/google/drive/common';
import { shredMemoryForLakeTags } from '@server/dataLakes/shredMemoryForLakeTags';
import { getFilesStorage } from '@server/utils/storage';
import { sendToQueue } from '@server/utils/sqs';
import { z, ZodError } from 'zod';

export const DriveDisconnectPurgePayload = z.object({
  connectionId: z.string(),
  dataLakeId: z.string(),
  organizationId: z.string(),
  // How many times this disconnect has waited out an in-flight sync; bounded by MAX_SYNC_DEFERRALS.
  syncDeferrals: z.number().int().nonnegative().optional(),
});
export type DriveDisconnectPurgePayload = z.infer<typeof DriveDisconnectPurgePayload>;

/** Files purged per invocation, sized to finish well inside the consumer's 10-minute timeout. */
export const DISCONNECT_PURGE_SLICE_SIZE = 1000;
/** 12 x 5 min covers the 60-minute chained sync-claim staleness bound (OrgGoogleDriveConnectionModel). */
const MAX_SYNC_DEFERRALS = 12;
const SYNC_DEFERRAL_DELAY_SEC = 300;

type PurgeLogger = {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
};

export type DriveDisconnectPurgeOutcome = 'released' | 'continued' | 'deferred' | 'dropped';

/**
 * Purge one bounded slice of the files a disconnected connection ingested, recompute the lake's
 * stats, then either re-enqueue for the remainder or release the connection row (revoking the
 * Google grant and freeing the folder claim). The row outlives every partial run, so a redelivery
 * re-resolves whatever is left from the DB; hardDeleteOneById's return keeps two overlapping runs
 * from refunding the same bytes twice (see purgeDataLakeConnectionFiles).
 */
export async function runDriveDisconnectPurge(
  payload: DriveDisconnectPurgePayload,
  {
    logger,
    enqueue,
    sliceSize = DISCONNECT_PURGE_SLICE_SIZE,
  }: {
    logger: PurgeLogger;
    enqueue: (message: DriveDisconnectPurgePayload, delaySeconds?: number) => Promise<unknown>;
    sliceSize?: number;
  }
): Promise<DriveDisconnectPurgeOutcome> {
  const { connectionId, dataLakeId, organizationId } = payload;
  const conn = await orgGoogleDriveConnectionRepository.findByDataLakeIdAny(dataLakeId);
  if (!conn || conn.id !== connectionId || conn.organizationId !== organizationId) {
    logger.info('[driveDisconnectPurge] connection already released; nothing to do', { connectionId, dataLakeId });
    return 'dropped';
  }
  if (!conn.disconnectRequestedAt) {
    logger.warn('[driveDisconnectPurge] no disconnect pending on this connection; dropping', { connectionId });
    return 'dropped';
  }

  // Re-asserted every run: it is the same compare-and-set the route took, so an ingest that slipped
  // in anyway (a lost race on a re-enable) finishes before this sweep resolves its slice.
  if (!(await orgGoogleDriveConnectionRepository.markDisconnecting(connectionId, organizationId))) {
    const syncDeferrals = (payload.syncDeferrals ?? 0) + 1;
    if (syncDeferrals > MAX_SYNC_DEFERRALS) {
      throw new Error(`Drive disconnect purge for ${connectionId} is still blocked by a sync; giving up`);
    }
    // Waiting out a sync is still progress; without this the chain reads as stalled mid-deferral and
    // the UI offers a retry the route would only 409.
    await orgGoogleDriveConnectionRepository.touchDisconnect(connectionId, organizationId);
    await enqueue({ ...payload, syncDeferrals }, SYNC_DEFERRAL_DELAY_SEC);
    logger.info('[driveDisconnectPurge] a sync is in flight; deferred', { connectionId, syncDeferrals });
    return 'deferred';
  }

  const lake = await dataLakeRepository.findById(dataLakeId);
  if (lake) {
    const remaining = await purgeSlice(lake, connectionId, sliceSize, logger);
    if (remaining) {
      await enqueue({ connectionId, dataLakeId, organizationId });
      logger.info('[driveDisconnectPurge] purged a slice; continuing', { connectionId, sliceSize });
      return 'continued';
    }
  }

  await releaseDriveConnection(connectionId, organizationId);
  logger.info('[driveDisconnectPurge] purged every ingested file and released the connection', {
    connectionId,
    dataLakeId,
  });
  return 'released';
}

/** Returns whether more files remain after this slice. */
async function purgeSlice(
  lake: IDataLakeDocument,
  driveConnectionId: string,
  sliceSize: number,
  logger: PurgeLogger
): Promise<boolean> {
  // includeDeleted: the reconcile default filters archivedAt/deletedAt, which for an ARCHIVED lake
  // (every member gets archivedAt-stamped on archive) returns nothing - the purge would silently
  // no-op while release still revoked the grant and hard-deleted the row.
  const found = await fabFileRepository.findByDriveConnectionIdInDataLake(driveConnectionId, lake.datalakeTag, {
    includeDeleted: true,
    limit: sliceSize + 1,
  });
  if (found.length === 0) return false;
  const files = found.slice(0, sliceSize);
  const purgingLake = { id: lake.id, datalakeTag: lake.datalakeTag, createdByUserId: lake.createdByUserId };
  await dataLakeService.purgeDataLakeConnectionFiles(dataLakeService.lakeMembershipScope(lake), files, {
    db: {
      fabFiles: fabFileRepository,
      fabFileChunks: fabFileChunkRepository,
      users: userRepository,
      dataLakeFindings: dataLakeFindingRepository,
      sessions: sessionRepository,
    },
    // Undefined everywhere except self-host OpenSearch - Atlas's vector index lives on the
    // FabFileChunk collection itself, so the chunk delete already removes it (same wiring as
    // dataLakeCleanup.ts).
    retrievalIndex: selfHostOpenSearchEnabled()
      ? dataLakeService.openSearchRetrievalIndex({
          db: { fabFileChunks: fabFileChunkRepository },
          searchIndex: FabFileChunkSearchIndex,
        })
      : undefined,
    storage: getFilesStorage(),
    // Mirrors purgeDataLakeDocument's shredDocumentMemory wiring, so a purged document's extracted
    // facts stop reaching live system prompts through recallLakeMemory.
    shredDocumentMemory: async ({ tagNames, fabFileId, ownerUserId }) => {
      await shredMemoryForLakeTags(tagNames, fabFileId, ownerUserId, purgingLake, { logger });
    },
    logger,
  });
  // Per slice, so DataLakeDiscoverPanel and the public browse route stop counting purged files
  // even if a later slice lands in the DLQ.
  await dataLakeService.recomputeLakeStats(lake, {
    db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository },
  });
  return found.length > sliceSize;
}

/**
 * Background consumer for the Drive disconnect purge, enqueued by DELETE
 * /api/data-lakes/:id/drive-connection once the connection is marked disconnecting. Hosted wiring
 * lives in infra/queues.ts; self-host polls the same dispatch from apps/workers/src/selfhost/main.ts.
 */
export const dispatch = dispatchWithLogger(async (event, _context, logger) => {
  try {
    const payload = DriveDisconnectPurgePayload.parse(JSON.parse(event.Records[0].body));
    logger.updateMetadata({
      handler: 'driveDisconnectPurge',
      connectionId: payload.connectionId,
      dataLakeId: payload.dataLakeId,
    });
    await runDriveDisconnectPurge(payload, {
      logger,
      enqueue: (message, delaySeconds) => sendToQueue(Resource.driveDisconnectPurgeQueue.url, message, delaySeconds),
    });
  } catch (err) {
    // Malformed payload: permanently invalid, so swallow rather than retry into the DLQ.
    if (err instanceof ZodError || err instanceof SyntaxError) {
      logger.warn(`Skipping drive-disconnect-purge message: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    throw err;
  }
});
