import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { getAgentDetail } from '@server/deepAgent/consoleReads';

/**
 * GET /api/deep-agent/agents/[agentId] - full charter + handoff + recent
 * episode tail for one agent. Owner-or-admin only. Console detail view.
 *
 * Query: episodes=N (default 20, max 100).
 */
const handler = baseApi().get(async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'no authenticated user' });

  const agentId = String(req.query.agentId || '');
  if (!agentId) return res.status(400).json({ error: 'agentId required' });

  // Clamp to [1, 100] - a negative value would reach Mongo, which treats
  // negative limits as absolute values and bypass the cap.
  const episodeLimit = Math.min(Math.max(Math.floor(Number(req.query.episodes)) || 20, 1), 100);
  const detail = await getAgentDetail(agentId, episodeLimit);
  if (!detail) return res.status(404).json({ error: `no charter for agent ${agentId}` });

  if (detail.charter.identity.ownerUserId !== userId && !req.user?.isAdmin) {
    return res.status(403).json({ error: 'not your agent' });
  }

  return res.json(detail);
});

export default handler;
