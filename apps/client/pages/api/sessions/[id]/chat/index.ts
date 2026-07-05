import { addMessageToSession, getMessagesFromSession } from '@server/managers/sessionManager';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@server/utils/errors';
import { z } from 'zod';
import qs from 'qs';
import { secureParameters } from '@bike4mind/utils';

const searchSchema = z.object({
  search: z.string().optional(),
  pagination: z
    .object({
      limit: z.coerce.number().positive().int().prefault(10),
      page: z.coerce.number().positive().int().prefault(1),
    })
    .optional(),
  all: z.coerce.boolean().prefault(false),
  sort: z.enum(['asc', 'desc']).prefault('asc'),
});

const handler = baseApi()
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const { id: sessionId } = req.query;
      const { search, ...options } = secureParameters(qs.parse(req.query), searchSchema);

      const result = await getMessagesFromSession(req.user!, sessionId!, search, options);
      return res.json(result);
    })
  )
  .post(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const { id: sessionId } = req.query ?? {};
      // TODO: zod parse req.body from IChatHistoryItem
      const message = z
        .object({
          timestamp: z.coerce.date(),
          type: z.enum(['system', 'message', 'error'] as const),
          prompt: z.string(),
          reply: z.string().optional(),
          replies: z.array(z.string()).optional(),
        })
        .parse(req.body);

      if (!sessionId || !message) {
        throw new NotFoundError('Session not found');
      }

      const userId = req.user?.id;
      const result = await addMessageToSession(userId, sessionId, message, req.ability!);
      return res.json(result.toJSON());
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
