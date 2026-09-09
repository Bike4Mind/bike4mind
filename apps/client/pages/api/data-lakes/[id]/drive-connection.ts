import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeRepository, orgGoogleDriveConnectionRepository } from '@bike4mind/database';
import type { IOrgGoogleDriveConnectionDocument } from '@bike4mind/common';
import { releaseDriveConnection } from '@server/integrations/google/drive/common';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { NotFoundError } from '@server/utils/errors';
import { Request } from 'express';

/**
 * Safe, credential-free view of a connection for the lake owner/manager. The refresh token is
 * `select: false` so it never reaches here anyway; this narrows further to just what the wizard
 * needs to show connection state and offer re-sync/disconnect.
 */
function toSafeConnection(c: IOrgGoogleDriveConnectionDocument) {
  return {
    id: c.id,
    driveFolderId: c.driveFolderId,
    folderName: c.folderName ?? null,
    status: c.status,
    enabled: c.enabled,
    lastError: c.lastError ?? null,
    lastUsedAt: c.lastUsedAt ?? null,
    connectedAt: c.connectedAt ?? null,
  };
}

/** Resolve the lake and assert the caller is an org owner/manager (mirrors the drive-sync gate). */
async function resolveOrgLake(req: Request): Promise<{ lakeId: string; organizationId: string }> {
  const { id } = req.query as { id: string };
  const lake = await dataLakeRepository.findById(id);
  // A Drive connection only exists for an org-scoped lake; a personal/fallback lake reads as not-found.
  if (!lake?.organizationId) {
    throw new NotFoundError('Data lake not found');
  }
  await verifyOrgAccess(req.user, lake.organizationId);
  return { lakeId: lake.id, organizationId: lake.organizationId };
}

/**
 * The lake's connection regardless of `enabled`, scoped to the lake's org.
 *
 * Deliberately NOT findByDataLakeId (which filters `enabled: true`): archiving or soft-deleting a
 * lake now DISABLES its connection rather than destroying it (disableDriveConnectionForLake), so an
 * enabled-only lookup would report the connection absent while the row still holds the live Google
 * grant and the globally-unique driveFolderId claim - the DELETE below would answer 204 without
 * revoking anything, and the folder would stay unclaimable by anyone.
 *
 * findByDataLakeIdAny is deliberately global (server-side only). The tenant boundary is
 * resolveOrgLake's verifyOrgAccess, which has already run; the comparison below is defence in depth
 * against inconsistent data - both sides derive from the same lake - and is NOT what scopes the
 * caller. A route that copies this finder needs the verifyOrgAccess, not just the comparison.
 */
async function findLakeConnection(lakeId: string, organizationId: string) {
  const conn = await orgGoogleDriveConnectionRepository.findByDataLakeIdAny(lakeId);
  if (conn && conn.organizationId !== organizationId) {
    throw new NotFoundError('Drive connection not found');
  }
  return conn;
}

/**
 * GET    /api/data-lakes/:id/drive-connection -> { connection: SafeConnection | null }
 * DELETE /api/data-lakes/:id/drive-connection -> 204 (revokes the Google grant and releases the
 *        folder claim so it can be re-used)
 *
 * Both answer for a DISABLED connection too (an archived/soft-deleted lake's) - see
 * findLakeConnection: `enabled` is a poll switch, not a disconnect, and only the DELETE here or the
 * phase-2 purge actually revokes.
 *
 * Org owner/manager (or platform admin) only. The connect + ingest trigger lives in POST
 * /api/data-lakes/drive-sync; this route is the per-lake status + disconnect surface.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request, res) => {
    const { lakeId, organizationId } = await resolveOrgLake(req);
    const conn = await findLakeConnection(lakeId, organizationId);
    return res.json({ connection: conn ? toSafeConnection(conn) : null });
  })
  .delete(async (req: Request, res) => {
    const { lakeId, organizationId } = await resolveOrgLake(req);
    const conn = await findLakeConnection(lakeId, organizationId);
    if (conn) {
      // Don't hard-delete under a live ingest: the running handler still holds the connection it
      // loaded and would keep creating FabFiles stamped with a driveConnectionId that no longer
      // resolves, while the UI reads "Disconnected". Make the user wait out (or the claim go stale).
      if (conn.status === 'syncing') {
        return res
          .status(409)
          .json({ error: 'A sync is in progress for this folder. Try disconnecting again once it finishes.' });
      }
      // Through the release seam, not the bare repo delete: it revokes the org-owned credential at
      // Google first, so disconnecting here does not leave the grant live behind a deleted row.
      await releaseDriveConnection(conn.id, organizationId);
    }
    return res.status(204).send();
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
