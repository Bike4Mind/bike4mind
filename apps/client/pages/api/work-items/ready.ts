import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { workItemRepository } from '@bike4mind/database';
import { assertLoopTicketAccess } from '@server/utils/loopTickets';
import { WORK_ITEM_RATE_LIMIT, WORK_ITEM_RATE_WINDOW_MS } from '@server/utils/workItemValidation';

/** Open work items whose dependencies are all closed - "what can I start now". */
const handler = baseApi()
  .use(rateLimit({ limit: WORK_ITEM_RATE_LIMIT, windowMs: WORK_ITEM_RATE_WINDOW_MS, bucket: 'work-items-ready' }))
  .get(async (req, res) => {
    const loopId = typeof req.query.loopId === 'string' ? req.query.loopId : undefined;
    if (loopId !== undefined) await assertLoopTicketAccess(req, loopId);
    const { data, truncated } = await workItemRepository.listReadyForUser(req.user!.id, loopId);
    res.json({ data, truncated });
  });

export default handler;
