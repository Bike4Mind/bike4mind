import { z } from 'zod';
import { TagType } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { buildUserFileScope } from '@server/utils/userFileScope';
import { tagService } from '@bike4mind/services';
import { fabFileRepository, fileTagRepository } from '@bike4mind/database';

const tagCreateBodySchema = z.object({
  name: z.string().trim().min(1),
  icon: z.string().optional(),
  description: z.string().optional(),
  color: z.string().optional(),
});

const handler = baseApi()
  .post(
    asyncHandler<{}, unknown, unknown>(async (req, res) => {
      if (!req.user.id) {
        throw new ForbiddenError('Unauthorized');
      }

      const body = tagCreateBodySchema.parse(req.body);
      const result = await tagService.create(
        req.user.id,
        { ...body, type: TagType.FILE },
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

      // Shared with counts.ts so the sidebar badge and the tag tree always count the same files.
      const result = await tagService.listFileTags(req.user.id, buildUserFileScope(req.user), {
        db: {
          fileTags: fileTagRepository,
          fabFiles: fabFileRepository,
        },
      });

      return res.json(result);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
