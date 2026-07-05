import { Request, Response } from 'express';
import { Memento } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';

const GetMementosQuerySchema = z.object({
  ids: z
    .string()
    .optional()
    .transform(val => (val ? val.split(',').filter(Boolean) : undefined)),
});

const handler = baseApi().get(async (req: Request, res: Response) => {
  const parseResult = GetMementosQuerySchema.safeParse(req.query);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Invalid query parameters',
      details: z.treeifyError(parseResult.error),
    });
  }

  const { ids } = parseResult.data;

  if (ids && ids.length > 0) {
    const mementos = await Memento.find({
      _id: { $in: ids },
      userId: req.user.id, // Ensure user can only access their own mementos
    });
    return res.json(mementos);
  }

  const mementos = await Memento.findByUserId(req.user.id);
  return res.json(mementos);
});

export default handler;
