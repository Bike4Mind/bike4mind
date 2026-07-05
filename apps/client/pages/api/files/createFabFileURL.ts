import { adminSettingsRepository, FabFile, User, withTransaction } from '@bike4mind/database';
import { Permission } from '@bike4mind/common';
import { fabFilesService } from '@bike4mind/services';
import { createFabFile } from '@server/managers/fabFileManager';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import { getFilesStorage } from '@server/utils/storage';
import { logEvent } from '@server/utils/analyticsLog';
import { FileEvents } from '@bike4mind/common';

const handler = baseApi()
  .use((req, res, next) => {
    if (!req.ability?.can(Permission.create, FabFile)) {
      throw new BadRequestError('Unauthorized');
    }
    next();
  })
  .post(
    asyncHandler<unknown, unknown, { url: string }>(async (req, res) => {
      const userId = req.user?.id;
      const { url } = req.body;

      if (!url) throw new BadRequestError('No URL provided');

      const newFabFile = await withTransaction(() =>
        fabFilesService.createFabFileByUrl(
          userId,
          { url },
          {
            db: {
              fabFiles: FabFile,
              adminSettings: adminSettingsRepository,
              users: User,
            },
            storage: {
              generateSignedUrl: (path, expireInSeconds) =>
                getFilesStorage().getSignedUrl(path, undefined, { expiresIn: expireInSeconds }),
              upload: (path, content, options) => getFilesStorage().upload(content, path, options),
            },
          }
        )
      );

      const savedFabFile = await createFabFile(newFabFile, req.ability!);

      await logEvent(
        {
          userId,
          type: FileEvents.CREATE_FILE_URL,
          metadata: {
            fileId: savedFabFile.id,
            fileSize: savedFabFile.fileSize,
            mimeType: savedFabFile.mimeType,
            fileUrl: url,
          },
        },
        { ability: req.ability }
      );

      return res.json(savedFabFile);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
