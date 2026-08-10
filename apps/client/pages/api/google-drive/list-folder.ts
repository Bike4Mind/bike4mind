import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import { getValidUserDriveAccessToken } from '@server/integrations/google/drive/common';
import {
  createDriveClient,
  listFolderChildren,
  isValidDriveFolderId,
} from '@server/integrations/google/drive/driveClient';

/**
 * List the immediate children of a Google Drive folder, server-side, using the current user's
 * connected Drive OAuth credential. This is the read primitive the Drive-as-lake ingest (issue C)
 * builds on, and the surface the live smoke test exercises (#1588).
 */
const handler = baseApi().post(
  asyncHandler<{}, unknown, { folderId?: string }>(async (req, res) => {
    const folderId = req.body?.folderId;
    if (!folderId || typeof folderId !== 'string') {
      throw new BadRequestError('folderId is required');
    }
    if (!isValidDriveFolderId(folderId)) {
      throw new BadRequestError('folderId is not a valid Drive folder id');
    }

    const accessToken = await getValidUserDriveAccessToken(req.user.id);
    const drive = createDriveClient(accessToken);
    const files = await listFolderChildren(drive, folderId);

    return res.json({ folderId, count: files.length, files });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
