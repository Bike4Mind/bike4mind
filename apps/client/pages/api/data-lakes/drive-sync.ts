import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeRepository, orgGoogleDriveConnectionRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { isValidDriveFolderId } from '@server/integrations/google/drive/driveClient';
import { BadRequestError } from '@server/utils/errors';
import { sendToQueue } from '@server/utils/sqs';
import { Request } from 'express';
import { Resource } from 'sst';
import { z } from 'zod';

const Body = z.object({
  dataLakeId: z.string(),
  driveFolderId: z.string(),
  folderName: z.string().optional(),
});

/**
 * Connect a Google Drive folder to a data lake and enqueue a background ingest (#1589).
 *
 * INTERIM: this also creates the OrgGoogleDriveConnection binding. The full org-owned connect flow
 * (OAuth token persistence, folder picker, verifyOrgAccess owner/manager gate) is issue D; until
 * then the ingest job uses the connecting user's own Drive credential (see
 * getValidConnectionDriveAccessToken). Enqueues by connectionId and returns 202.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request, res) => {
    const { dataLakeId, driveFolderId, folderName } = Body.parse(req.body);
    if (!isValidDriveFolderId(driveFolderId)) {
      throw new BadRequestError('driveFolderId is not a valid Drive folder id');
    }

    // Connecting a source into a lake is a WRITE - gate on write access (creator/admin), not read.
    const lake = await dataLakeService.assertLakeWriteAccess(dataLakeId, await toAccessContext(req), {
      db: { dataLakes: dataLakeRepository },
    });

    if (!lake.organizationId) {
      // The connection model is org-scoped (organizationId required). Personal-lake support is a follow-up.
      throw new BadRequestError('Google Drive ingest currently requires an organization-scoped data lake');
    }

    // A Drive folder is claimable by at most one lake, and a lake is fed by at most one folder
    // (both enforced by unique indexes). Resolve to a connection id or reject the conflict clearly.
    const byFolder = await orgGoogleDriveConnectionRepository.findByDriveFolderId(driveFolderId);
    let connectionId: string;

    if (byFolder) {
      if (byFolder.targetDataLakeId !== dataLakeId) {
        return res.status(409).json({ error: 'This Drive folder is already connected to another data lake' });
      }
      // Same folder + lake: reuse the connection and re-ingest (the handler dedups by driveFileId).
      connectionId = byFolder.id;
    } else {
      try {
        const created = await orgGoogleDriveConnectionRepository.create({
          organizationId: lake.organizationId,
          authMode: 'oauth',
          driveFolderId,
          folderName,
          targetDataLakeId: dataLakeId,
          connectedBy: req.user.id,
          enabled: true,
          status: 'connected',
          connectedAt: new Date(),
        });
        connectionId = created.id;
      } catch (e) {
        // Unique targetDataLakeId: the lake is already connected to a different folder.
        const message = e instanceof Error ? e.message : String(e);
        if (/duplicate key|E11000/i.test(message)) {
          return res.status(409).json({ error: 'This data lake is already connected to a different Drive folder' });
        }
        throw e;
      }
    }

    await sendToQueue(Resource.driveLakeIngestQueue.url, { connectionId });

    return res.status(202).json({ connectionId, status: 'queued' });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
