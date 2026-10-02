import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES, assertDataLakeWriteScope } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import {
  dataLakeRepository,
  fabFileRepository,
  isDriveSyncClaimLive,
  orgGoogleDriveConnectionRepository,
} from '@bike4mind/database';
import { driveConnectionOwnerOf, isDriveDisconnectStalled, isSameDriveConnectionOwner } from '@bike4mind/common';
import type { DriveConnectionOwner, IDataLakeDocument, IOrgGoogleDriveConnectionDocument } from '@bike4mind/common';
import type { DriveDisconnectPurgePayload } from '@server/queueHandlers/driveDisconnectPurge';
import { listDeletableDriveOrphans } from '@server/integrations/google/drive/connectorOrphanFiles';
import { authorizeLakeDriveAccess } from '@server/integrations/google/drive/authorizeLakeDriveAccess';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { sendToQueue } from '@server/utils/sqs';
import { NotFoundError } from '@server/utils/errors';
import { Request } from 'express';

/**
 * Safe, credential-free view of a connection for the lake owner/manager. The refresh token is
 * `select: false` so it never reaches here anyway; this narrows further to just what the wizard
 * needs to show connection state and offer re-sync/disconnect.
 *
 * `fileCount` rides along so the disconnect-confirmation dialog can warn how many documents a
 * disconnect will delete without a separate round trip.
 */
function toSafeConnection(c: IOrgGoogleDriveConnectionDocument, fileCount: number) {
  return {
    id: c.id,
    driveFolderId: c.driveFolderId,
    folderName: c.folderName ?? null,
    status: c.status,
    syncStale: c.status === 'syncing' && !isDriveSyncClaimLive(c),
    enabled: c.enabled,
    lastError: c.lastError ?? null,
    lastUsedAt: c.lastUsedAt ?? null,
    connectedAt: c.connectedAt ?? null,
    fileCount,
    disconnecting: !!c.disconnectRequestedAt,
    disconnectStalled: !!c.disconnectRequestedAt && isDriveDisconnectStalled(c.disconnectRequestedAt),
  };
}

/**
 * Resolve the lake and assert the caller may manage its Drive connection - an org owner/manager on an
 * org lake, the creator on a personal one (the same gate as drive-sync).
 */
async function resolveLake(req: Request): Promise<{ lake: IDataLakeDocument; owner: DriveConnectionOwner }> {
  const { id } = req.query as { id: string };
  const lake = await dataLakeRepository.findById(id);
  if (!lake) {
    throw new NotFoundError('Data lake not found');
  }
  const owner = await authorizeLakeDriveAccess(req.user, lake);
  return { lake, owner };
}

/**
 * The lake's connection regardless of `enabled`, scoped to the lake's owner.
 *
 * Deliberately NOT findByDataLakeId (which filters `enabled: true`): archiving or soft-deleting a
 * lake now DISABLES its connection rather than destroying it (disableDriveConnectionForLake), so an
 * enabled-only lookup would report the connection absent while the row still holds the live Google
 * grant and the globally-unique driveFolderId claim - the DELETE below would answer 204 without
 * revoking anything, and the folder would stay unclaimable by anyone.
 *
 * findByDataLakeIdAny is deliberately global (server-side only). The tenant boundary is
 * resolveLake's authorizeLakeDriveAccess, which has already run; the comparison below is defence in
 * depth against inconsistent data - both sides derive from the same lake - and is NOT what scopes the
 * caller. A route that copies this finder needs the authorization, not just the comparison.
 */
async function findLakeConnection(lakeId: string, owner: DriveConnectionOwner) {
  const conn = await orgGoogleDriveConnectionRepository.findByDataLakeIdAny(lakeId);
  if (conn && !isSameDriveConnectionOwner(driveConnectionOwnerOf(conn), owner)) {
    throw new NotFoundError('Drive connection not found');
  }
  return conn;
}

/**
 * GET    /api/data-lakes/:id/drive-connection -> { connection: SafeConnection | null }
 * DELETE /api/data-lakes/:id/drive-connection -> 202 once the purge is queued (the
 *        driveDisconnectPurge consumer deletes the ingested files, then revokes the Google grant and
 *        releases the folder claim), or 204 when there is no connection
 *
 * Both answer for a DISABLED connection too (an archived/soft-deleted lake's) - see
 * findLakeConnection: `enabled` is a poll switch, not a disconnect, and only the DELETE here or the
 * phase-2 purge actually revokes.
 *
 * Both are gated like drive-sync: an org owner/manager (or platform admin) on an org lake, the
 * creator on a personal lake. A lake with no connection resolves 200 with a null connection rather
 * than 404 - a caller needs to tell "no connection" from "can't tell" apart, and conflating them into
 * one 404 broke every consumer that renders differently for the two (see useLakeDriveConnection).
 * A 404 from GET therefore always means a real failure: the lake doesn't exist, or the caller may not
 * manage its Drive connection. The connect + ingest trigger lives in POST
 * /api/data-lakes/drive-sync; this route is the per-lake status + disconnect surface.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request, res) => {
    const { lake, owner } = await resolveLake(req);
    const conn = await findLakeConnection(lake.id, owner);
    if (!conn) {
      return res.json({ connection: null });
    }
    const fileCount = await fabFileRepository.countByDriveConnectionIdInDataLake(conn.id, lake.datalakeTag);
    // The confirm number must equal what the purge removes, so it folds in the gate-cleared orphans
    // (files this connection unpicked and left alive) the purge sweeps the same way - the member
    // count alone under-reports exactly the rows this change is about.
    const orphans = await listDeletableDriveOrphans(lake, conn.id, req.logger);
    return res.json({ connection: toSafeConnection(conn, fileCount + orphans.length) });
  })
  .delete(async (req: Request, res) => {
    assertDataLakeWriteScope(req);
    const { lake, owner } = await resolveLake(req);
    const conn = await findLakeConnection(lake.id, owner);
    if (conn) {
      // A purge that ran recently is still progressing; another message would only start a second
      // self-re-enqueueing chain over the same files. `queued: false` here is accurate, not just
      // idempotent: self-heals once DRIVE_DISCONNECT_STALL_MS passes and the next DELETE retries.
      if (conn.disconnectRequestedAt && !isDriveDisconnectStalled(conn.disconnectRequestedAt)) {
        return res.status(202).json({ success: true, queued: false });
      }
      // Don't hard-delete under a live ingest: the running handler still holds the connection it
      // loaded and would keep creating FabFiles stamped with a driveConnectionId that no longer
      // resolves, while the UI reads "Disconnected". Make the user wait out (or the claim go stale).
      //
      // Disabling and the syncing check are ONE atomic compare-and-set (markDisconnecting), not a
      // snapshot read (the `conn` above) followed by an unconditional disable: a message already on
      // the ingest queue could otherwise win claimForSync in the gap between the read and the write,
      // create FabFiles past the queued purge's snapshot, and have its row hard-deleted by release -
      // stranding those files exactly like the bug this purge exists to fix. claimForSync's own
      // `enabled` guard is the other half - either this disable wins or that claim already did, never
      // both.
      const marked = await orgGoogleDriveConnectionRepository.markDisconnecting(conn.id, owner);
      if (!marked) {
        return res
          .status(409)
          .json({ error: 'A sync is in progress for this folder. Try disconnecting again once it finishes.' });
      }
      // Queued rather than inline: purge time scales with the folder, and the row stays behind as
      // the retry anchor until the consumer has swept every file and released it.
      const message: DriveDisconnectPurgePayload = {
        connectionId: conn.id,
        dataLakeId: lake.id,
        ...(owner.kind === 'organization' && { organizationId: owner.organizationId }),
      };
      try {
        await sendToQueue(getSourceQueueUrl('driveDisconnectPurgeQueue'), message);
      } catch (error) {
        // No message behind the mark would leave the connection disabled with nothing to finish it,
        // so undo it - but only a mark this call created, and only if nothing re-stamped it since
        // (a concurrent DELETE whose message did land, or a purge run already under way).
        if (marked.created) {
          try {
            await orgGoogleDriveConnectionRepository.cancelDisconnect(
              conn.id,
              owner,
              marked.stamp,
              marked.previousEnabled
            );
          } catch (cancelError) {
            req.logger.error('Failed to roll back a Drive disconnect whose purge could not be queued', {
              dataLakeId: lake.id,
              error: cancelError instanceof Error ? cancelError.message : 'Unknown error',
            });
          }
        }
        throw error;
      }
      return res.status(202).json({ success: true, queued: true });
    }
    return res.status(204).send();
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
