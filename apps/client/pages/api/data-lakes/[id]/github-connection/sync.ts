import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_WRITE_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeRepository, isGitHubLakeSyncClaimLive, orgGitHubLakeConnectionRepository } from '@bike4mind/database';
import { isLakeIngestable, isSameLakeConnectionOwner, lakeConnectionOwnerOf } from '@bike4mind/common';
import { authorizeLakeConnectorAccess } from '@server/dataLakes/authorizeLakeConnectorAccess';
import { BadRequestError, ConflictError, InternalServerError, NotFoundError } from '@server/utils/errors';
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
    if (!lake) {
      throw new NotFoundError('Data lake not found');
    }
    const owner = await authorizeLakeConnectorAccess(req.user, lake);
    if (!isLakeIngestable(lake.status)) {
      throw new BadRequestError(`Cannot sync a data lake in '${lake.status}' status`);
    }
    // findByDataLakeIdAny is global; the owner comparison is defence in depth behind the gate above.
    const conn = await orgGitHubLakeConnectionRepository.findByDataLakeIdAny(lake.id);
    if (!conn || !isSameLakeConnectionOwner(lakeConnectionOwnerOf(conn), owner)) {
      throw new NotFoundError('GitHub connection not found');
    }
    if (conn.enabled === false) {
      throw new ConflictError('This GitHub connection is disabled');
    }
    if (isGitHubLakeSyncClaimLive(conn)) {
      throw new ConflictError('A sync is already running for this repository');
    }
    try {
      await sendToQueue(Resource.githubLakeIngestQueue.url, { connectionId: conn.id, manual: true });
    } catch (error) {
      req.logger.error('GitHub manual re-sync enqueue failed', { connectionId: conn.id, error });
      // lastError surfaces the failure on the connection, same as the connect flow's first-sync
      // enqueue (githubLakeConnection.ts); best-effort so a record failure doesn't mask the real one.
      await orgGitHubLakeConnectionRepository
        .recordLastError(conn.id, 'Re-sync could not be queued. Try again.')
        .catch(e =>
          req.logger.warn('GitHub manual re-sync: could not record the enqueue failure', {
            connectionId: conn.id,
            error: e,
          })
        );
      throw new InternalServerError('Could not queue the GitHub re-sync. Please try again.');
    }
    return res.status(202).json({ connectionId: conn.id, status: 'queued' });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
