import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeRepository, orgGoogleDriveConnectionRepository, User } from '@bike4mind/database';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import {
  isValidDriveFolderId,
  createDriveClient,
  getFolderAccess,
} from '@server/integrations/google/drive/driveClient';
import { getValidUserDriveAccessToken } from '@server/integrations/google/drive/common';
import { decryptToken } from '@server/security/tokenEncryption';
import { isEncrypted } from '@server/security/secretEncryption';
import { BadRequestError, ForbiddenError, InternalServerError, NotFoundError } from '@server/utils/errors';
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
 * Capture the connecting user's Drive refresh token as the connection's OWN durable credential.
 *
 * The token is copied verbatim from `User.googleDrive.refreshToken` (already encrypted at rest with
 * the same key/scheme), so ingest survives the user later disconnecting their personal Drive or
 * leaving the org - the connection no longer depends on `User.googleDrive` (see
 * getValidConnectionDriveAccessToken). Fails fast if the credential is missing, not encrypted, or
 * unreadable, so we never persist a connection that cannot actually sync. This is also the isEncrypted
 * guard the model relies on (crypto is not reachable from packages/database).
 */
async function captureOrgCredential(userId: string): Promise<string> {
  const user = await User.findById(userId, 'googleDrive');
  const encryptedRefresh = user?.googleDrive?.refreshToken;
  if (!encryptedRefresh) {
    throw new BadRequestError(
      'Connect your Google Drive before connecting a folder (reconnect to grant offline access).'
    );
  }
  if (!isEncrypted(encryptedRefresh)) {
    throw new BadRequestError(
      'Your Google Drive credential is not stored securely - reconnect Google Drive and try again.'
    );
  }
  try {
    if (!decryptToken(encryptedRefresh)) throw new Error('empty credential');
  } catch {
    throw new BadRequestError('Your Google Drive credential is unreadable - reconnect Google Drive and try again.');
  }
  return encryptedRefresh;
}

/**
 * Connect a Google Drive folder to a data lake and enqueue a background ingest (#1589).
 *
 * Creates (or refreshes) the OrgGoogleDriveConnection binding with an org-owned credential and
 * enqueues by connectionId (202). Binding an org-wide credential and globally claiming a Drive folder
 * is an org-administrative act, so this gates on org owner/manager (verifyOrgAccess), NOT merely the
 * lake's creator. The folder picker that supplies driveFolderId lands in the same PR's UI commit.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request, res) => {
    const { dataLakeId, driveFolderId, folderName } = Body.parse(req.body);
    if (!isValidDriveFolderId(driveFolderId)) {
      throw new BadRequestError('driveFolderId is not a valid Drive folder id');
    }

    const lake = await dataLakeRepository.findById(dataLakeId);
    if (!lake) {
      throw new NotFoundError('Data lake not found');
    }
    if (!lake.organizationId) {
      // The connection model is org-scoped (organizationId required); a fallback/personal lake has
      // no org and so is excluded here. Personal-lake support is a follow-up.
      throw new BadRequestError('Google Drive ingest currently requires an organization-scoped data lake');
    }

    // Org owner/manager (or platform admin) only - not the lake creator (see the handler note).
    await verifyOrgAccess(req.user, lake.organizationId);

    const oauthRefreshToken = await captureOrgCredential(req.user.id);

    // Verify the connecting user can actually READ the folder before claiming it. The claim is GLOBAL
    // (one folder -> one lake, ever), so without this any org owner/manager could squat a folder id
    // they don't own - ids appear in shared Drive URLs - and permanently lock out its real owner. Drive
    // 404s a folder the caller can't see, so a successful read IS the ownership proof (uses the user's
    // own credential, not the org copy).
    const folderAccess = await getFolderAccess(
      createDriveClient(await getValidUserDriveAccessToken(req.user.id)),
      driveFolderId
    );
    if (!folderAccess.exists) {
      throw new ForbiddenError('That Google Drive folder does not exist or you do not have access to it.');
    }
    if (!folderAccess.isFolder) {
      throw new BadRequestError('That Drive item is not a folder.');
    }
    if (!folderAccess.canRead) {
      throw new ForbiddenError('You do not have permission to read that Google Drive folder.');
    }

    // A Drive folder is claimable by at most one lake, and a lake is fed by at most one folder
    // (both enforced by unique indexes). Resolve to a connection id or reject the conflict clearly.
    const byFolder = await orgGoogleDriveConnectionRepository.findByDriveFolderId(driveFolderId);
    let connectionId: string;
    let claimedByThisRequest = false;

    if (byFolder) {
      if (byFolder.targetDataLakeId !== dataLakeId) {
        return res.status(409).json({ error: 'This Drive folder is already connected to another data lake' });
      }
      // Same folder + lake: refresh the stored credential (a reconnect is often to fix a broken one)
      // and re-stamp connectedBy to this user, then re-ingest (the handler dedups by driveFileId). Set
      // connectedBy so ingest runs as a still-present user even if the original connector was deleted.
      const updated = await orgGoogleDriveConnectionRepository.updateCredential(
        byFolder.id,
        lake.organizationId,
        oauthRefreshToken,
        req.user.id
      );
      if (!updated) {
        // Org-scoped update matched nothing: the folder's existing connection belongs to another org
        // (findByDriveFolderId is global). Don't 202 a success that changed nothing.
        return res.status(409).json({ error: 'This Drive folder is already connected to another data lake' });
      }
      connectionId = byFolder.id;
    } else {
      try {
        const created = await orgGoogleDriveConnectionRepository.create({
          organizationId: lake.organizationId,
          authMode: 'oauth',
          driveFolderId,
          folderName,
          targetDataLakeId: dataLakeId,
          oauthRefreshToken,
          connectedBy: req.user.id,
          enabled: true,
          status: 'connected',
          connectedAt: new Date(),
        });
        connectionId = created.id;
        claimedByThisRequest = true;
      } catch (e) {
        // Unique targetDataLakeId: the lake is already connected to a different folder.
        const message = e instanceof Error ? e.message : String(e);
        if (/duplicate key|E11000/i.test(message)) {
          return res.status(409).json({ error: 'This data lake is already connected to a different Drive folder' });
        }
        throw e;
      }
    }

    try {
      await sendToQueue(Resource.driveLakeIngestQueue.url, { connectionId });
    } catch (e) {
      // The connection row is what holds the GLOBAL driveFolderId claim, so an enqueue that fails
      // after we created it (SQS unavailable/throttled, an IAM denial, an unregistered queue) would
      // take the folder out of circulation for EVERY org until someone deleted the row by hand -
      // disabling it does not help, a disabled row still populates the unique index. Release the
      // claim and fail, so the folder stays re-claimable and the UI never reads Connected for a
      // folder whose ingest was never accepted.
      //
      // Only a claim THIS request took is released: on the reuse branch the connection pre-existed,
      // and tearing down a working connection because a re-sync could not be enqueued would be far
      // worse than the missed ingest (the resync poll re-enqueues it anyway).
      let released = false;
      if (claimedByThisRequest) {
        released = await orgGoogleDriveConnectionRepository
          .release(connectionId, lake.organizationId)
          .catch(() => false);
      }
      // The raw error is log-only: an SQS/IAM failure message carries queue urls and account ids.
      req.logger.error('Google Drive ingest enqueue failed', {
        connectionId,
        driveFolderId,
        claimedByThisRequest,
        released,
        error: e instanceof Error ? e.message : String(e),
      });
      throw new InternalServerError('Could not queue the Google Drive ingest. Please try again.');
    }

    return res.status(202).json({ connectionId, status: 'queued' });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
