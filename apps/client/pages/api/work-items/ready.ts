import { baseApi } from '@client/server/middlewares/baseApi';
import { workItemRepository } from '@bike4mind/database';

/** Open work items whose dependencies are all closed - "what can I start now". */
const handler = baseApi().get(async (req, res) => {
  const items = await workItemRepository.listReadyForUser(req.user!.id);
  res.json({ data: items });
});

export default handler;
