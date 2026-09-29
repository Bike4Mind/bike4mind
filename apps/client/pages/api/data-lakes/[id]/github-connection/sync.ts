import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_WRITE_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeRepository, isGitHubLakeSyncClaimLive, orgGitHubLakeConnectionRepository } from '@bike4mind/database';
import { isLakeIngestable } from '@bike4mind/common';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { BadRequestError, ConflictError, NotFoundError } from '@server/utils/errors';
import { sendToQueue } from '@server/utils/sqs';
import { Request } from 'express';
import { Resource } from 'sst';

/** POST /api/data-lakes/:id/github-connection/sync -> 202 { connectionId, status: 'queued' } (manual re-sync). */
const handler = baseApi({ requiredScopes: DATA_LAKE_WRITE_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .use(requireFeatureEnabled('EnableDataLakeGitHub'))
  .post(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const lake = await dataLakeRepository.findById(id);
    if (!lake?.organizationId) {
      throw new NotFoundError('Data lake not found');
    }
    await verifyOrgAccess(req.user, lake.organizationId);
    if (!isLakeIngestable(lake.status)) {
      throw new BadRequestError(`Cannot sync a data lake in '${lake.status}' status`);
    }
    // findByDataLakeIdAny is global; the org comparison is defence in depth behind verifyOrgAccess.
    const conn = await orgGitHubLakeConnectionRepository.findByDataLakeIdAny(lake.id);
    if (!conn || conn.organizationId !== lake.organizationId) {
      throw new NotFoundError('GitHub connection not found');
    }
    if (conn.enabled === false) {
      throw new ConflictError('This GitHub connection is disabled');
    }
    if (isGitHubLakeSyncClaimLive(conn)) {
      throw new ConflictError('A sync is already running for this repository');
    }
    await sendToQueue(Resource.githubLakeIngestQueue.url, { connectionId: conn.id, manual: true });
    return res.status(202).json({ connectionId: conn.id, status: 'queued' });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
