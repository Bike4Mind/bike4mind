import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { listAgentsForOwner } from '@server/deepAgent/consoleReads';

/**
 * GET /api/deep-agent/agents - the caller's deep-agent roster (newest activity
 * first), each with its latest handoff state. Console list view.
 */
const handler = baseApi().get(async (req: Request, res: Response) => {
  const ownerUserId = req.user?.id;
  if (!ownerUserId) return res.status(401).json({ error: 'no authenticated user' });

  // Clamp to [1, 200] - a negative value would reach Mongo, which treats
  // negative limits as absolute values and bypass the cap.
  const limit = Math.min(Math.max(Math.floor(Number(req.query.limit)) || 50, 1), 200);
  const agents = await listAgentsForOwner(ownerUserId, limit);
  return res.json({ agents });
});

export default handler;
