import { Request, Response } from 'express';
import { z } from 'zod';
import { Logger } from '@bike4mind/observability';
import { agentRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
// Direct file imports (NOT the @server/deepAgent barrel - its subtree pulls the
// Lambda-runtime import graph, which deadlocks module init under Next dev).
import { enrollMissionForAgent, listMissionsForAgent } from '@server/deepAgent/missions';
import { MongoDeepAgentStore } from '@server/deepAgent/store';
import { runMissionFirstWake } from '@server/deepAgent/firstWake';

/**
 * /api/agents/[id]/missions - Missions of an existing B4M Agent.
 *
 * GET  -> mission roster for the agent (owner-or-admin).
 * POST -> create a mission (goal + options) and run its FIRST wake inline,
 *        inheriting the agent's persona + tool policy. Admin/dev gated while
 *        the feature matures (same gate as /api/deep-agent/spin); credit
 *        enforcement relaxes this in M5.
 */
const CreateMissionInputSchema = z.object({
  goal: z.string().min(1).max(4000),
  role: z.string().min(1).max(120).optional(),
  successCriteria: z.array(z.string().min(1)).max(20).optional(),
  enableTools: z.boolean().optional(),
  modelId: z.string().optional(),
});

const handler = baseApi()
  .use(rateLimit({ limit: process.env.NODE_ENV === 'development' ? 30 : 5, windowMs: 60 * 1000 }))
  .get(async (req: Request, res: Response) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'no authenticated user' });
    const b4mAgentId = String(req.query.id || '');
    if (!b4mAgentId) return res.status(400).json({ error: 'agent id required' });

    const agent = await agentRepository.findById(b4mAgentId);
    if (!agent) return res.status(404).json({ error: `no agent ${b4mAgentId}` });
    // Read access mirrors GET /api/agents/[id]: owner, explicitly-shared, or
    // admin. A strict `!==` (not `agent.userId &&`) means an ownerless org/
    // system agent does NOT leak its mission roster to every authenticated user.
    const isSharedWithUser = agent.users?.some((u: { userId: string }) => u.userId === userId);
    if (agent.userId !== userId && !isSharedWithUser && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'not your agent' });
    }

    const missions = await listMissionsForAgent(b4mAgentId);
    return res.json({ missions });
  })
  .post(async (req: Request, res: Response) => {
    // Authenticate (401) before authorizing (403) - consistent with the rest of
    // the API; otherwise a missing/expired session is masked as a 403.
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'no authenticated user' });

    const hasAccess =
      req.user?.isAdmin ||
      (req.user?.tags ?? []).map(t => t.toLowerCase()).some(t => ['developer', 'dev', 'developers'].includes(t));
    if (!hasAccess) return res.status(403).json({ error: 'admin/developer access required' });

    const b4mAgentId = String(req.query.id || '');
    if (!b4mAgentId) return res.status(400).json({ error: 'agent id required' });

    const parsed = CreateMissionInputSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    }
    const input = parsed.data;
    const logger = new Logger({ metadata: { component: 'agent-missions', b4mAgentId } });
    const t0 = Date.now();

    try {
      const store = new MongoDeepAgentStore();
      const { missionId } = await enrollMissionForAgent(
        {
          b4mAgentId,
          callerUserId: userId,
          callerIsAdmin: req.user?.isAdmin,
          goal: input.goal,
          role: input.role,
          successCriteria: input.successCriteria,
        },
        store
      );

      // First wake inline so the mission is born alive (cron is the steady
      // state). Shared with the chat `create_mission` tool via runMissionFirstWake.
      const outcome = await runMissionFirstWake(missionId, {
        logger,
        modelId: input.modelId,
        enableTools: input.enableTools,
        userId,
      });

      return res.json({
        missionId,
        latency_ms: Date.now() - t0,
        episode: {
          id: outcome.episode.id,
          policy: outcome.episode.policyDecision,
          actionsTaken: outcome.episode.actionsTaken,
          reflection: outcome.episode.reflection,
          scopeLocks: outcome.episode.scopeLocks,
          tokensSpent: outcome.episode.tokensSpent,
        },
        handoff: {
          wakeCount: outcome.handoff.wakeCount,
          nextIntendedAction: outcome.handoff.nextIntendedAction,
        },
      });
    } catch (error) {
      const message = (error as Error).message;
      if (/not your agent/.test(message)) return res.status(403).json({ error: message });
      if (/no agent /.test(message)) return res.status(404).json({ error: message });
      logger.error('mission create failed', error as Error);
      return res.status(500).json({ error: message });
    }
  });

export default handler;
