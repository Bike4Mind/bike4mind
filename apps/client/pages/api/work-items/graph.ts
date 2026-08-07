import { baseApi } from '@client/server/middlewares/baseApi';
import { workItemRepository } from '@bike4mind/database';

/** The user's work-item dependency DAG as nodes + edges. */
const handler = baseApi().get(async (req, res) => {
  const graph = await workItemRepository.buildGraphForUser(req.user!.id);
  res.json(graph);
});

export default handler;
