import { Prompt, promptRepository } from '@bike4mind/database';
import { promptService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';

const handler = baseApi().delete(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const id = req.query.id;
    if (!id) throw new BadRequestError('Invalid ID');

    if (!req.ability) {
      throw new NotFoundError('Ability not found');
    }

    if (!req.ability.can('delete', Prompt)) {
      throw new NotFoundError('Permission denied');
    }

    await promptService.deletePrompt({ id }, { db: { prompts: promptRepository } });

    // Next.js API responses have no Express `sendStatus`; use status().end() for 204.
    return res.status(204).end();
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
