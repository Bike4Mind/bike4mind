import { getSharedSessionsByUser } from '@server/managers/sessionManager';
import { redactSessionsForClient, sessionSearchSchema } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';
import qs from 'qs';
import { Request } from 'express';

const searchSchema = z
  .object({
    query: z.string().optional(),
    filter: z
      .object({
        userId: z.string().optional(),
      })
      .optional(),
    pagination: z
      .object({
        page: z.coerce.number().int().positive().prefault(1),
        limit: z.coerce.number().int().positive().prefault(10),
      })
      .optional(),
  })
  .extend(sessionSearchSchema.pick({ origin: true, excludeOrigin: true, hasImages: true }).shape);

const handler = baseApi().get<Request<{}, {}, {}, Record<string, string>>>(async (req, res) => {
  try {
    const { query, pagination, origin, excludeOrigin, hasImages } = searchSchema.parse(qs.parse(req.query));

    const result = req.user
      ? await getSharedSessionsByUser(req.user, query, { pagination, filters: { origin, excludeOrigin, hasImages } })
      : [];
    // Redact server-owned fields (e.g. systemPromptText) - shared sessions are owned by
    // other users, so this is the main non-owner leak path. Redact in both the
    // { data, hasMore } and bare-array shapes so a future refactor can't bypass it.
    return res.json(
      Array.isArray(result)
        ? redactSessionsForClient(result)
        : { ...result, data: redactSessionsForClient(result.data) }
    );
  } catch (err) {
    console.error(err);
    return res.status(400).json({ message: 'Failed to get sessions', error: err });
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
