import { Request, Response } from 'express';
import { Memento } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';

/**
 * A memento's `embedding` is 1536 floats - roughly 30KB of JSON on its own, dwarfing everything else
 * in the document. Serialising it for every memento a user owns is what made this route return a body
 * larger than Lambda will accept (6MB), so the handler answered 200 and the runtime turned it into a
 * 502: the list simply stopped working for anyone with a few hundred mementos, with no error the user
 * could see. Nothing that renders a memento reads the vector - it exists for server-side cosine - so it
 * is excluded by default and only sent when a caller explicitly asks.
 */
const LIST_PROJECTION = '-embedding';

const GetMementosQuerySchema = z.object({
  ids: z
    .string()
    .optional()
    .transform(val => (val ? val.split(',').filter(Boolean) : undefined)),
  /** Opt in to the raw vectors. Pair with `limit`/`skip` - the whole point is that they do not all fit. */
  includeEmbeddings: z
    .string()
    .optional()
    .transform(val => val === 'true' || val === '1'),
  limit: z.coerce.number().int().positive().max(500).optional(),
  skip: z.coerce.number().int().nonnegative().optional(),
});

const handler = baseApi().get(async (req: Request, res: Response) => {
  const parseResult = GetMementosQuerySchema.safeParse(req.query);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Invalid query parameters',
      details: z.treeifyError(parseResult.error),
    });
  }

  const { ids, includeEmbeddings, limit, skip } = parseResult.data;

  // Always scoped to the caller: a user may only read their own mementos.
  const filter = {
    userId: req.user.id,
    ...(ids && ids.length > 0 ? { _id: { $in: ids } } : {}),
  };

  const query = Memento.find(filter).sort({ lastAccessedAt: -1 });
  if (!includeEmbeddings) query.select(LIST_PROJECTION);
  if (typeof skip === 'number') query.skip(skip);
  if (typeof limit === 'number') query.limit(limit);

  const mementos = await query.exec();
  return res.json(mementos);
});

export default handler;
