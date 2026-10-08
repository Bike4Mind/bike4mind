import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES, assertDataLakeWriteScope } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import {
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  fabFileRepository,
  orgGitHubLakeConnectionRepository,
  withTransaction,
} from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { z } from 'zod';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';
import { getGitHubLakeAppConfig } from '@server/integrations/github/dataLake/lakeAppClient';
import {
  buildGitHubLakeAuthorizeUrl,
  requestGitHubLakeDisconnect,
  requireGitHubLakeAppConfig,
  resolveConnectableLake,
  toGitHubLakeConnectionResponse,
} from '@server/integrations/github/dataLake/githubLakeConnection';
import { verifyOrgAccess, verifyOrgAdminRead } from '@server/utils/orgAccess';
import { NotFoundError } from '@server/utils/errors';
import { Request } from 'express';

/**
 * The lake's connection, scoped to the lake's org. findByDataLakeIdAny is global; the tenant
 * boundary is the caller's org gate (verifyOrgAdminRead on GET, verifyOrgAccess on DELETE), and the
 * org comparison here is defence in depth only (same contract as drive-connection.ts findLakeConnection).
 */
async function findLakeConnection(lakeId: string, organizationId: string) {
  const conn = await orgGitHubLakeConnectionRepository.findByDataLakeIdAny(lakeId);
  if (conn && conn.organizationId !== organizationId) {
    throw new NotFoundError('GitHub connection not found');
  }
  return conn;
}

const StartGitHubConnectBody = z.object({ ensureConnectorFed: z.boolean().optional() }).strict();

/**
 * Switches a curated lake to connector-fed through the same gates and audited service as PUT
 * /api/data-lakes/:id, so the switch lands in the config history like any other origin edit.
 */
async function switchLakeToConnectorFed(req: Request, lakeId: string) {
  const ctx = await toAccessContext(req);
  const actor = { ...ctx, auditPrincipal: lakeConfigAuditPrincipal(req.user!, req.apiKeyInfo) };
  await withTransaction(async () => {
    const lake = await dataLakeService.assertLakeAccess(lakeId, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    dataLakeService.assertLakeWritable(lake);
    await dataLakeService.updateDataLake(
      actor,
      lake.id,
      { origin: 'connector-fed' },
      {
        db: {
          dataLakes: dataLakeRepository,
          dataLakeAccessGrants: dataLakeAccessGrantRepository,
          ...lakeConfigAuditDb,
        },
        logger: req.logger,
      }
    );
  });
}

/**
 * GET    /api/data-lakes/:id/github-connection -> { connection: IOrgGitHubLakeConnectionResponse | null,
 *        canManage: boolean } (always false for a personal lake: GitHub lakes are org-only, so there is nothing to manage)
 * POST   /api/data-lakes/:id/github-connection -> { authorizeUrl } (starts the connect, see
 *        buildGitHubLakeAuthorizeUrl. The callback page relays GitHub's return to POST
 *        /api/data-lakes/github-callback; the picker then lists .../repositories and binds via
 *        .../complete). Body `{ ensureConnectorFed: true }` switches a curated lake to connector-fed
 *        first, but only once every start check has passed, so a refused start writes nothing and
 *        there is no client-side revert to race a concurrent connect.
 * DELETE /api/data-lakes/:id/github-connection -> 202 { success, queued } (disables the connection
 *        and queues the purge of what it ingested, 409 while a sync is live; the row stays, reading
 *        `disconnecting`, until the purge releases it - see requestGitHubLakeDisconnect), or 204
 *        when the lake has no connection
 *
 * Mirrors drive-connection.ts: GET answers a personal lake with a null connection (it genuinely has
 * none), so a 404 always means the lake is missing or the caller has no standing on its org. GET also
 * admits an appointed org admin (the view is credential-free); POST and DELETE are org owner/manager
 * (or platform admin) only, and `canManage` tells the client which controls to offer.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .use(requireFeatureEnabled('EnableDataLakeGitHub'))
  .get(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const lake = await dataLakeRepository.findById(id);
    if (!lake) {
      throw new NotFoundError('Data lake not found');
    }
    if (!lake.organizationId) {
      return res.json({ connection: null, canManage: false });
    }
    const { canManage } = await verifyOrgAdminRead(req.user, lake.organizationId);
    const conn = await findLakeConnection(lake.id, lake.organizationId);
    if (!conn) {
      return res.json({ connection: null, canManage });
    }
    // Rides along for the disconnect confirmation, which must say how many files the purge deletes.
    const fileCount = await fabFileRepository.countByGitHubConnectionIdInDataLake(conn.id, lake.datalakeTag);
    return res.json({ connection: toGitHubLakeConnectionResponse(conn, fileCount), canManage });
  })
  .post(async (req: Request, res) => {
    assertDataLakeWriteScope(req);
    const { id } = req.query as { id: string };
    // `|| {}`: a bodyless POST (the plain start) arrives as an empty string, not an object.
    const { ensureConnectorFed = false } = StartGitHubConnectBody.parse(req.body || {});
    const config = requireGitHubLakeAppConfig(getGitHubLakeAppConfig());
    const { lakeId, curated } = await resolveConnectableLake(req.user, id, { allowCurated: ensureConnectorFed });
    if (curated) {
      await switchLakeToConnectorFed(req, lakeId);
    }
    return res.json({
      authorizeUrl: buildGitHubLakeAuthorizeUrl(res, config, { userId: req.user.id, dataLakeId: lakeId }),
    });
  })
  .delete(async (req: Request, res) => {
    assertDataLakeWriteScope(req);
    const { id } = req.query as { id: string };
    const lake = await dataLakeRepository.findById(id);
    // A GitHub connection only exists for an org-scoped lake; a personal lake reads as not-found.
    if (!lake?.organizationId) {
      throw new NotFoundError('Data lake not found');
    }
    await verifyOrgAccess(req.user, lake.organizationId);
    const conn = await findLakeConnection(lake.id, lake.organizationId);
    if (!conn) {
      return res.status(204).send();
    }
    const { queued } = await requestGitHubLakeDisconnect(conn, req.logger);
    return res.status(202).json({ success: true, queued });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
