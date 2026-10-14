import { adminSettingsRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { BadRequestError } from '@server/utils/errors';
import { MAX_FILE_SIZE_DEFAULT_MB } from '@server/utils/maxFileSizeDefault';
import { getValidUserDriveAccessToken } from '@server/integrations/google/drive/common';
import {
  createDriveClient,
  isValidDriveFolderId,
  withDriveReconnectOnAuthError,
} from '@server/integrations/google/drive/driveClient';
import { estimateFolder } from '@server/integrations/google/drive/driveContent';
import { MAX_INGEST_CANDIDATES } from '@server/integrations/google/drive/driveIngestLimits';

// Well under the 60s server Lambda and CloudFront origin timeouts: one in-flight page plus
// withDriveRetry's ~7s of backoff can still land after the deadline.
const ESTIMATE_DEADLINE_MS = 20_000;
const ESTIMATE_MAX_FOLDERS = 2000;

/**
 * Pre-flight size estimate of a Drive folder tree for the Create Data Lake wizard, so it can refuse
 * a folder that would exceed the user's storage quota or the per-sync file cap before anything is
 * created. The Drive lake worker (driveLakeIngest) stays the hard boundary; MaxFileSize is resolved
 * here the same way it resolves it, so the client never supplies the limit.
 *
 * `auth: 'jwtOnly'` for the same reason as list-folder: it walks the caller's Drive under
 * drive.readonly, which an unrelated api key should not authorize. Internal, not a public contract.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  // Each call can spend ~20s of Drive quota walking a tree; the wizard fetches once per folder pick.
  .use(rateLimit({ limit: 10, windowMs: 60 * 1000 }))
  .post(
    asyncHandler<{}, unknown, { folderId?: string }>(async (req, res) => {
      const folderId = req.body?.folderId;
      if (!folderId || typeof folderId !== 'string') {
        throw new BadRequestError('folderId is required');
      }
      if (!isValidDriveFolderId(folderId)) {
        throw new BadRequestError('folderId is not a valid Drive folder id');
      }

      const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, { names: ['MaxFileSize'] });
      const maxFileSizeBytes = getSettingsValue('MaxFileSize', settings, MAX_FILE_SIZE_DEFAULT_MB) * 1024 * 1024;

      const accessToken = await getValidUserDriveAccessToken(req.user.id);
      const drive = createDriveClient(accessToken);
      const estimate = await withDriveReconnectOnAuthError(() =>
        estimateFolder(drive, folderId, {
          deadlineMs: Date.now() + ESTIMATE_DEADLINE_MS,
          maxFolders: ESTIMATE_MAX_FOLDERS,
          maxFileSize: maxFileSizeBytes,
        })
      );

      return res.json({ folderId, ...estimate, maxFileSizeBytes, candidateCap: MAX_INGEST_CANDIDATES });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
