import { Request, Response } from 'express';
import { Memento } from '@bike4mind/database/content';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@bike4mind/utils';

const handler = baseApi().delete(async (req: Request, res: Response) => {
  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: 'Memento ID is required' });
  }

  const memento = await Memento.findById(id);
  if (!memento) {
    return res.status(404).json({ error: `Memento ${id} not found` });
  }
  if (!req.ability) {
    throw new NotFoundError('Ability not found');
  }
  if (!req.ability.can('delete', memento)) {
    throw new NotFoundError('Permission denied');
  }

  await memento.deleteOne();
  return res.status(200).json({ message: 'Memento deleted successfully' });
});

export default handler;
