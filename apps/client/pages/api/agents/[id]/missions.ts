import { Request, Response } from 'express';
import { z } from 'zod';
import { Logger } from '@bike4mind/observability';
import { agentRepository } from '@bike4mind/database';
import { ForbiddenError, NotFoundError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { assertAgentsReadScope, assertAgentsWriteScope, AGENTS_READ_OR_WRITE_SCOPES } from '@server/agents/agentScopes';
import { assertAgentAccess, type AgentAccess, type AgentAccessShape } from '@server/agents/assertAgentAccess';
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

// One body for a missing agent and one the caller cannot reach, so the response never confirms the id exists.
const AGENT_NOT_FOUND_MESSAGE = 'Agent not found';

type AccessDenial = 'not-found' | 'forbidden';

// Not `assertAgentAccess` alone: its thrown NotFoundError renders with extra envelope fields, and a
// missing id must stay byte-identical to a hidden one on these hand-written responses. Admins see any
// agent that exists.
function agentAccessDenial(
  agent: AgentAccessShape | null | undefined,
  userId: string,
  isAdmin: boolean | undefined,
  access: AgentAccess
): AccessDenial | undefined {
  if (!agent) return 'not-found';
  if (isAdmin) return undefined;
  try {
    assertAgentAccess(agent, userId, access);
    return undefined;
  } catch (error) {
    if (error instanceof NotFoundError) return 'not-found';
    if (error instanceof ForbiddenError) return 'forbidden';
    throw error;
  }
}

// baseApi's scope gate is per route, so it admits either agents scope and each method asserts its own.
const handler = baseApi({ requiredScopes: AGENTS_READ_OR_WRITE_SCOPES })
  .use(rateLimit({ limit: process.env.NODE_ENV === 'development' ? 30 : 5, windowMs: 60 * 1000 }))
  .get(async (req: Request, res: Response) => {
    assertAgentsReadScope(req);
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'no authenticated user' });
    const b4mAgentId = String(req.query.id || '');
    if (!b4mAgentId) return res.status(400).json({ error: 'agent id required' });

    const agent = await agentRepository.findById(b4mAgentId);
    if (agentAccessDenial(agent, userId, req.user?.isAdmin, 'view')) {
      return res.status(404).json({ error: AGENT_NOT_FOUND_MESSAGE });
    }

    const missions = await listMissionsForAgent(b4mAgentId);
    return res.json({ missions });
  })
  .post(async (req: Request, res: Response) => {
    assertAgentsWriteScope(req);
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

    const agent = await agentRepository.findById(b4mAgentId);
    const denial = agentAccessDenial(agent, userId, req.user?.isAdmin, 'own');
    if (denial === 'not-found') return res.status(404).json({ error: AGENT_NOT_FOUND_MESSAGE });
    if (denial === 'forbidden') {
      return res.status(403).json({ error: "You don't have permission to create missions for this agent" });
    }

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
      if (/not your agent|no agent /.test(message)) return res.status(404).json({ error: AGENT_NOT_FOUND_MESSAGE });
      logger.error('mission create failed', error as Error);
      return res.status(500).json({ error: message });
    }
  });

export default handler;
