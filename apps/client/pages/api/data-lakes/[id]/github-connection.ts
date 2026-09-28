import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES, assertDataLakeWriteScope } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeRepository, orgGitHubLakeConnectionRepository } from '@bike4mind/database';
import { getGitHubLakeAppConfig } from '@server/integrations/github/dataLake/lakeAppClient';
import {
  buildGitHubLakeConnectUrls,
  releaseGitHubLakeConnection,
  requireGitHubLakeAppConfig,
  resolveConnectableLake,
  toGitHubLakeConnectionResponse,
} from '@server/integrations/github/dataLake/githubLakeConnection';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { NotFoundError } from '@server/utils/errors';
import { Request } from 'express';

/**
 * The lake's connection, scoped to the lake's org. findByDataLakeIdAny is global; the tenant
 * boundary is the caller's verifyOrgAccess, and the org comparison here is defence in depth only
 * (same contract as drive-connection.ts findLakeConnection).
 */
async function findLakeConnection(lakeId: string, organizationId: string) {
  const conn = await orgGitHubLakeConnectionRepository.findByDataLakeIdAny(lakeId);
  if (conn && conn.organizationId !== organizationId) {
    throw new NotFoundError('GitHub connection not found');
  }
  return conn;
}

/**
 * GET    /api/data-lakes/:id/github-connection -> { connection: IOrgGitHubLakeConnectionResponse | null }
 * POST   /api/data-lakes/:id/github-connection -> { installUrl, authorizeUrl } (starts the connect; see
 *        buildGitHubLakeConnectUrls for when the callback page needs authorizeUrl. The page then
 *        completes the flow via POST /api/data-lakes/github-callback)
 * DELETE /api/data-lakes/:id/github-connection -> { installationRetained } (see
 *        releaseGitHubLakeConnection for when the App stays installed)
 *
 * Mirrors drive-connection.ts: GET answers a personal lake with a null connection (it genuinely has
 * none), so a 404 always means the lake is missing or the caller is not an org owner/manager. POST
 * and DELETE are org owner/manager (or platform admin) only.
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
      return res.json({ connection: null });
    }
    await verifyOrgAccess(req.user, lake.organizationId);
    const conn = await findLakeConnection(lake.id, lake.organizationId);
    return res.json({ connection: conn ? toGitHubLakeConnectionResponse(conn) : null });
  })
  .post(async (req: Request, res) => {
    assertDataLakeWriteScope(req);
    const { id } = req.query as { id: string };
    const config = requireGitHubLakeAppConfig(getGitHubLakeAppConfig());
    const { lakeId } = await resolveConnectableLake(req.user, id);
    return res.json(buildGitHubLakeConnectUrls(res, config, { userId: req.user.id, dataLakeId: lakeId }));
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
      return res.json({ installationRetained: false });
    }
    // The App config is only needed to uninstall; a retained installation releases without it.
    const result = await releaseGitHubLakeConnection(conn, getGitHubLakeAppConfig());
    return res.json(result);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
