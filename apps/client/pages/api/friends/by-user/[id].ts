import { friendshipRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { Request } from 'express';

/**
 * An API endpoint to fetch friendship document by friend's user ID and current user ID
 */
const handler = baseApi().get<Request<unknown, unknown, unknown, { id: string }>>(async (req, res) => {
  const user = req.user;
  const { id: friendUserId } = req.query;

  const friendship = await friendshipRepository.findByUsers(user.id, friendUserId);

  return res.json(friendship);
});

export default handler;
