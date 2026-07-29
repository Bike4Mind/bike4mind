import { TagType, getDataLakeTags } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { tagService } from '@bike4mind/services';
import { fabFileRepository, fileTagRepository } from '@bike4mind/database';

const handler = baseApi()
  .post(
    asyncHandler<{}, unknown, unknown>(async (req, res) => {
      if (!req.user.id) {
        throw new ForbiddenError('Unauthorized');
      }

      const result = await tagService.create(
        req.user.id,
        {
          type: TagType.FILE,
          ...(req.body as any),
        },
        {
          db: {
            fileTags: fileTagRepository,
          },
        }
      );

      return res.json(result);
    })
  )
  .get(
    asyncHandler<{}, unknown, unknown>(async (req, res) => {
      if (!req.user.id) {
        throw new ForbiddenError('Unauthorized');
      }

      // Same scoping as the sibling counts.ts, so the sidebar badge and the tag tree count the
      // same set of files.
      const result = await tagService.listFileTags(
        req.user.id,
        {
          userGroups: req.user.groups ?? [],
          dataLakeTags: getDataLakeTags(req.user.tags ?? []),
        },
        {
          db: {
            fileTags: fileTagRepository,
            fabFiles: fabFileRepository,
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
