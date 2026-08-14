import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { workItemRepository } from '@bike4mind/database';
import { WORK_ITEM_RATE_LIMIT, WORK_ITEM_RATE_WINDOW_MS } from '@server/utils/workItemValidation';

/** The user's work-item dependency DAG as nodes + edges. */
const handler = baseApi()
  .use(rateLimit({ limit: WORK_ITEM_RATE_LIMIT, windowMs: WORK_ITEM_RATE_WINDOW_MS, bucket: 'work-items-graph' }))
  .get(async (req, res) => {
    const graph = await workItemRepository.buildGraphForUser(req.user!.id);
    res.json(graph);
  });

export default handler;
