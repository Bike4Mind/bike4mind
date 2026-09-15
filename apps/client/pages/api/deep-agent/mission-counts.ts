import { Request, Response } from 'express';
import { deepAgentCharterRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';

/**
 * GET /api/deep-agent/mission-counts - mission count per linked B4M agent for
 * the caller. Feeds the badges in the chat Agents panel and sidebar.
 *
 * Rate-limited like the sibling mission routes: the client polls this on a 60s
 * interval and each call runs an aggregation, so cap accidental bursts.
 */
const handler = baseApi()
  .use(rateLimit({ limit: 60, windowMs: 60 * 1000 }))
  .get(async (req: Request, res: Response) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'no authenticated user' });
    const counts = await deepAgentCharterRepository.countByLinkedAgentForOwner(userId);
    return res.json({ counts });
  });

export default handler;
