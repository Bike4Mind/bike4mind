import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import { dataLakeRepository, fabFileRepository, userRepository } from '@bike4mind/database';
import { fileTagRepository } from '@bike4mind/database';

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown>(async (req, res) => {
    if (!req.user.id) {
      throw new ForbiddenError('Unauthorized');
    }

    // Toggling a lake's `datalake:*` meta-tag onto a file is a WRITE into that lake, so gate it
    // with the creator/admin check so this path can't inject files into a lake the caller only
    // reads (mirrors the remove path).
    const toggledTags: string[] = Array.isArray((req.body as { tags?: unknown })?.tags)
      ? (req.body as { tags: unknown[] }).tags.filter((t): t is string => typeof t === 'string')
      : [];
    await dataLakeService.assertCanWriteDataLakeTags(
      { userId: req.user.id, isAdmin: !!req.user.isAdmin },
      toggledTags,
      {
        db: { dataLakes: dataLakeRepository },
      }
    );

    const result = await fabFilesService.toggleTags(
      req.user.id,
      {
        ...(req.body as any),
      },
      {
        db: {
          fabFiles: fabFileRepository,
          fileTags: fileTagRepository,
          users: userRepository,
        },
      }
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
