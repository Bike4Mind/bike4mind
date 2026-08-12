import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeRepository, orgGoogleDriveConnectionRepository } from '@bike4mind/database';
import type { IOrgGoogleDriveConnectionDocument } from '@bike4mind/common';
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
 * GET    /api/data-lakes/:id/drive-connection -> { connection: SafeConnection | null }
 * DELETE /api/data-lakes/:id/drive-connection -> 204 (releases the folder claim so it can be re-used)
 *
 * Org owner/manager (or platform admin) only. The connect + ingest trigger lives in POST
 * /api/data-lakes/drive-sync; this route is the per-lake status + disconnect surface.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request, res) => {
    const { lakeId, organizationId } = await resolveOrgLake(req);
    const conn = await orgGoogleDriveConnectionRepository.findByDataLakeId(lakeId, organizationId);
    return res.json({ connection: conn ? toSafeConnection(conn) : null });
  })
  .delete(async (req: Request, res) => {
    const { lakeId, organizationId } = await resolveOrgLake(req);
    const conn = await orgGoogleDriveConnectionRepository.findByDataLakeId(lakeId, organizationId);
    if (conn) {
      // Don't hard-delete under a live ingest: the running handler still holds the connection it
      // loaded and would keep creating FabFiles stamped with a driveConnectionId that no longer
      // resolves, while the UI reads "Disconnected". Make the user wait out (or the claim go stale).
      if (conn.status === 'syncing') {
        return res
          .status(409)
          .json({ error: 'A sync is in progress for this folder. Try disconnecting again once it finishes.' });
      }
      await orgGoogleDriveConnectionRepository.release(conn.id, organizationId);
    }
    return res.status(204).send();
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
