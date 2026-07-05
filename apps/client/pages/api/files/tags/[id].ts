import { ITagRepository, TagType } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { tagService } from '@bike4mind/services';
import { fileTagRepository } from '@bike4mind/database';

const handler = baseApi()
  .put(
    asyncHandler<{}, unknown, unknown>(async (req, res) => {
      if (!req.user.id) {
        throw new ForbiddenError('Unauthorized');
      }

      const result = await tagService.update(
        req.user.id,
        {
          type: TagType.FILE,
          ...(req.body as any),
        },
        {
          db: {
            tags: fileTagRepository as unknown as ITagRepository,
          },
        }
      );

      return res.json(result);
    })
  )
  .delete(
    asyncHandler<{}, unknown, unknown>(async (req, res) => {
      if (!req.user.id) {
        throw new ForbiddenError('Unauthorized');
      }

      const result = await tagService.remove(
        req.user.id,
        {
          ...(req.query as any),
        },
        {
          db: {
            tags: fileTagRepository,
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
