import { CreateFabFileRequestInputType, FileEvents, Permission } from '@bike4mind/common';
import { adminSettingsRepository, dataLakeRepository, FabFile, User, withTransaction } from '@bike4mind/database';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import { logEvent } from '@server/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import { getFilesStorage } from '@server/utils/storage';

const createFabFileSchema = fabFilesService.createFabFileSchema;

const handler = baseApi()
  .use((req, res, next) => {
    if (!req.ability?.can(Permission.create, FabFile)) {
      throw new BadRequestError('Unauthorized');
    }
    next();
  })
  .post(
    asyncHandler<unknown, unknown, CreateFabFileRequestInputType>(async (req, res) => {
      const { user } = req;

      const params = createFabFileSchema.parse(req.body);

      // Applying a lake's `datalake:*` meta-tag at creation is a WRITE into that lake - gate it
      // with the creator/admin check so this path can't be used to bypass the Send-to-Data-Lake
      // authorization and inject files into a lake the caller only reads.
      await dataLakeService.assertCanWriteDataLakeTags(
        { userId: user.id, isAdmin: !!user.isAdmin },
        (params.tags ?? []).map(t => t.name),
        { db: { dataLakes: dataLakeRepository } }
      );

      const result = await withTransaction(async () => {
        return fabFilesService.createFabFile(user.id, params, {
          db: {
            adminSettings: adminSettingsRepository,
            fabFiles: FabFile,
            users: User,
          },
          storage: {
            upload: async (filepath, content, option) => {
              await getFilesStorage().upload(content, filepath, {
                ContentType: option?.ContentType || 'text/plain',
                ContentLength: option?.ContentLength || Buffer.byteLength(content, 'utf8'),
              });
              return filepath;
            },
            generateSignedUrl: (filepath: string, expireInSeconds: number) =>
              getFilesStorage().getSignedUrl(filepath, 'put', {
                expiresIn: expireInSeconds,
              }),
          },
        });
      });

      await logEvent(
        { userId: user.id, type: FileEvents.CREATE_FILE, metadata: { fileId: result.id } },
        { ability: req.ability }
      );

      return res.json(result);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
