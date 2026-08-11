import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeRepository, orgGoogleDriveConnectionRepository, User } from '@bike4mind/database';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { isValidDriveFolderId } from '@server/integrations/google/drive/driveClient';
import { decryptToken } from '@server/security/tokenEncryption';
import { isEncrypted } from '@server/security/secretEncryption';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
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

    // A Drive folder is claimable by at most one lake, and a lake is fed by at most one folder
    // (both enforced by unique indexes). Resolve to a connection id or reject the conflict clearly.
    const byFolder = await orgGoogleDriveConnectionRepository.findByDriveFolderId(driveFolderId);
    let connectionId: string;

    if (byFolder) {
      if (byFolder.targetDataLakeId !== dataLakeId) {
        return res.status(409).json({ error: 'This Drive folder is already connected to another data lake' });
      }
      // Same folder + lake: refresh the stored credential (a reconnect is often to fix a broken one)
      // and re-ingest (the handler dedups by driveFileId).
      await orgGoogleDriveConnectionRepository.updateCredential(byFolder.id, lake.organizationId, oauthRefreshToken);
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
