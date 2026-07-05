import { Request, Response } from 'express';
import { z } from 'zod';
import { Logger } from '@bike4mind/observability';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { MongoDeepAgentStore } from '@server/deepAgent/store';
import { createLlmReviewStep, runReviewWake } from '@server/deepAgent/reviewWake';
import { bridgeReviewToSession } from '@server/deepAgent/missionSessionBridge';
import { DEFAULT_WAKE_MODEL_ID, resolveDeepAgentBackend } from '@server/deepAgent/resolveBackend';

/**
 * POST /api/deep-agent/review  (admin/dev only)
 *
 * Run an adversarial review over one of an agent's episodes: an independent
 * reviewer pass (refuting stance) produces a verdict, the review is recorded
 * as an episode, the target gets a reviewer back-pointer, and tier advancement
 * is gated on approval.
 */
const ReviewInput = z.object({
  agentId: z.string().min(1),
  episodeId: z.string().min(1),
  /** Model override for the reviewer (defaults to the light tier). */
  modelId: z.string().optional(),
});

const handler = baseApi()
  .use(rateLimit({ limit: process.env.NODE_ENV === 'development' ? 30 : 10, windowMs: 60 * 1000 }))
  .post(async (req: Request, res: Response) => {
    const hasAccess =
      req.user?.isAdmin ||
      (req.user?.tags ?? []).map(t => t.toLowerCase()).some(t => ['developer', 'dev', 'developers'].includes(t));
    if (!hasAccess) return res.status(403).json({ error: 'admin/developer access required' });

    const parsed = ReviewInput.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    }
    const { agentId, episodeId, modelId } = parsed.data;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'no authenticated user' });

    const logger = new Logger({ metadata: { component: 'deep-agent.review', agentId, episodeId } });
    const t0 = Date.now();

    try {
      const store = new MongoDeepAgentStore();
      const charter = await store.loadCharter(agentId);
      if (!charter) return res.status(404).json({ error: `no charter for agent ${agentId}` });
      if (charter.identity.ownerUserId !== userId && !req.user?.isAdmin) {
        return res.status(403).json({ error: 'not your agent' });
      }

      const resolved = await resolveDeepAgentBackend(modelId ?? DEFAULT_WAKE_MODEL_ID, logger);
      if (!resolved) return res.status(500).json({ error: 'could not resolve reviewer model' });

      const outcome = await runReviewWake(agentId, episodeId, {
        store,
        reviewStep: createLlmReviewStep({ llm: resolved.llm, modelId: resolved.modelId }),
      });

      void bridgeReviewToSession(charter, outcome, episodeId, logger);
      logger.info('deep agent review complete', {
        verdict: outcome.verdict.verdict,
        tierAdvanced: outcome.tierAdvanced,
      });
      return res.json({ ...outcome, latency_ms: Date.now() - t0 });
    } catch (error) {
      const message = (error as Error).message;
      // Reviews are write-once - a repeat request is a conflict, not a failure.
      if (/already reviewed/.test(message)) {
        return res.status(409).json({ error: message });
      }
      logger.error('deep agent review failed', error as Error);
      return res.status(500).json({ error: message });
    }
  });

export default handler;
