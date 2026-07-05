import { Memento } from '@bike4mind/database/content';
import { NotFoundError, UnauthorizedError } from '@bike4mind/utils';
import { baseApi } from '@client/server/middlewares/baseApi';
import { Request, Response } from 'express';

export default baseApi({
  auth: true,
}).post(async (req: Request, res: Response) => {
  const { user } = req;
  if (!req.ability) {
    throw new NotFoundError('Ability not found');
  }
  if (!req.ability.can('deleteMany', Memento)) {
    throw new UnauthorizedError('Permission denied');
  }
  await Memento.deleteMany({ userId: user.id });
  res.status(200).json({ message: 'All mementos deleted successfully' });
});
