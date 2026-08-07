import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { tagService } from '@bike4mind/services';
import { fabFileRepository, fileTagRepository } from '@bike4mind/database';

type TagIdQuery = { id?: string | string[] };

/** The editable fields, minus the id - the URL supplies that. Read off the service so the two cannot drift. */
type TagUpdateBody = Omit<Parameters<typeof tagService.update>[1], 'id'>;

/**
 * The `[id]` URL segment is the tag id on both verbs, and it wins over anything in the body. PUT
 * used to take the id from the body spread instead, which left the URL segment decorative on one
 * verb and load-bearing on the other: `PUT /api/files/tags/A` with a body of `{"id":"B"}` edited
 * tag B. Anything other than one non-empty string is refused outright: an array is never a valid
 * tag id, and picking a member out of one would be guessing at which caller meant what.
 */
const requireTagId = (query: TagIdQuery): string => {
  const { id } = query;

  if (typeof id !== 'string' || id.length === 0) {
    throw new BadRequestError('A tag id is required in the URL');
  }

  return id;
};

const handler = baseApi()
  .put(
    asyncHandler<{}, unknown, TagUpdateBody, TagIdQuery>(async (req, res) => {
      if (!req.user.id) {
        throw new ForbiddenError('Unauthorized');
      }

      const result = await tagService.update(
        req.user.id,
        {
          ...req.body,
          id: requireTagId(req.query),
        },
        {
          db: {
            tags: fileTagRepository,
            fabFiles: fabFileRepository,
          },
        }
      );

      return res.json(result);
    })
  )
  .delete(
    asyncHandler<{}, unknown, unknown, TagIdQuery>(async (req, res) => {
      if (!req.user.id) {
        throw new ForbiddenError('Unauthorized');
      }

      const result = await tagService.remove(
        req.user.id,
        {
          id: requireTagId(req.query),
        },
        {
          db: {
            tags: fileTagRepository,
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
