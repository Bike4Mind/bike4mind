import { Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { Logger } from '@bike4mind/observability';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
// Direct file imports (NOT the @server/deepAgent barrel): the barrel's subtree
// pulls in wakeHandler -> queueHandlers/utils -> the Lambda-runtime import graph,
// which deadlocks module init under the Next dev server. Every other deep-agent
// route already imports by file for the same reason. The wake deps are
// assembled inline from the clean modules instead of wakeHandler's
// buildDefaultWakeDeps for the same reason.
import { createReActRunAct, noopRunAct, runWakeCycle, type WakeDeps } from '@bike4mind/agents';
import { enrollDeepAgent } from '@server/deepAgent/enroll';
import { MongoDeepAgentStore } from '@server/deepAgent/store';
import { LlmWakeSteps } from '@server/deepAgent/llmSteps';
import { createDeepAgentToolMaterializer } from '@server/deepAgent/toolMaterializer';
import { DEFAULT_WAKE_MODEL_ID, resolveDeepAgentBackend } from '@server/deepAgent/resolveBackend';
import { loadLinkedAgentContext } from '@server/deepAgent/missions';
import { bridgeWakeToSession } from '@server/deepAgent/missionSessionBridge';

/**
 * POST /api/deep-agent/spin  (admin/dev only)
 *
 * Live test harness for the Deep Agent loop. Enrolls a fresh agent owned by the
 * caller, then runs ONE wake cycle synchronously (bypassing the SQS queue/cron,
 * which need a deploy) so you can see orient -> act -> reflect -> groom end to end.
 *
 * `enableTools: false` (default) -> think-only act (orient + reflect, no tools).
 * `enableTools: true` -> real ReActAgent act with the role's b4m toolbelt, run
 * as the caller. Start think-only to validate cognition, then escalate.
 */
const SpinInput = z.object({
  name: z.string().min(1).max(120).optional(),
  role: z.string().min(1).max(120).optional(),
  goal: z.string().min(1).max(4000).optional(),
  modelId: z.string().optional(),
  enableTools: z.boolean().optional(),
  /** Re-wake an EXISTING agent (skips enrollment) - drives multi-wake arcs. */
  agentId: z.string().min(1).optional(),
});

const handler = baseApi()
  .use(rateLimit({ limit: process.env.NODE_ENV === 'development' ? 30 : 5, windowMs: 60 * 1000 }))
  .post(async (req: Request, res: Response) => {
    const hasAccess =
      req.user?.isAdmin ||
      (req.user?.tags ?? []).map(t => t.toLowerCase()).some(t => ['developer', 'dev', 'developers'].includes(t));
    if (!hasAccess) {
      return res.status(403).json({ error: 'admin/developer access required' });
    }

    const parsed = SpinInput.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    }
    const input = parsed.data;
    const ownerUserId = req.user?.id;
    if (!ownerUserId) {
      return res.status(401).json({ error: 'no authenticated user' });
    }

    const logger = new Logger({ metadata: { component: 'deep-agent.spin', ownerUserId } });
    const t0 = Date.now();

    try {
      const store = new MongoDeepAgentStore();
      let agentId: string;
      if (input.agentId) {
        // Re-wake an existing agent - owner check so you can only drive your own.
        const existing = await store.loadCharter(input.agentId);
        if (!existing) return res.status(404).json({ error: `no charter for agent ${input.agentId}` });
        if (existing.identity.ownerUserId !== ownerUserId && !req.user?.isAdmin) {
          return res.status(403).json({ error: 'not your agent' });
        }
        agentId = input.agentId;
      } else {
        // Enroll a fresh agent owned by the caller. No-op enqueue - we wake inline.
        const enrolled = await enrollDeepAgent(
          {
            ownerUserId,
            name: input.name ?? 'Spin Test Agent',
            role: input.role ?? 'paper-repro',
            goal: { description: input.goal ?? 'Reproduce a target result and record evidence.' },
          },
          { store, enqueueWake: async () => {} }
        );
        agentId = enrolled.agentId;
      }

      // 2. Run one wake cycle synchronously (deps assembled inline - see imports note).
      const resolved = await resolveDeepAgentBackend(input.modelId ?? DEFAULT_WAKE_MODEL_ID, logger);
      if (!resolved) return res.status(500).json({ error: 'could not resolve wake model' });
      const runAct = input.enableTools
        ? createReActRunAct({
            llm: resolved.llm,
            model: resolved.modelId,
            logger,
            buildTools: createDeepAgentToolMaterializer({ llm: resolved.llm, model: resolved.modelId, logger }),
            loadLinkedAgent: loadLinkedAgentContext,
          })
        : noopRunAct;
      const deps: WakeDeps = {
        store,
        steps: new LlmWakeSteps({ adapters: { llm: resolved.llm, modelId: resolved.modelId }, runAct }),
        newEpisodeId: () => randomUUID(),
        logger,
      };
      const outcome = await runWakeCycle(agentId, deps);
      void bridgeWakeToSession(outcome, logger);

      return res.json({
        agentId,
        latency_ms: Date.now() - t0,
        enableTools: input.enableTools ?? false,
        episode: {
          id: outcome.episode.id,
          evidenceTier: outcome.episode.evidenceTier,
          policy: outcome.episode.policyDecision,
          actionsTaken: outcome.episode.actionsTaken,
          observations: outcome.episode.observations,
          reflection: outcome.episode.reflection,
          scopeLocks: outcome.episode.scopeLocks,
          drivesBefore: outcome.episode.drivesBefore,
          drivesAfter: outcome.episode.drivesAfter,
          tokensSpent: outcome.episode.tokensSpent,
        },
        handoff: {
          wakeCount: outcome.handoff.wakeCount,
          lastActionSummary: outcome.handoff.lastActionSummary,
          nextIntendedAction: outcome.handoff.nextIntendedAction,
          nextWakeIntervalMs: outcome.handoff.nextWakeIntervalMs,
        },
        charter: {
          version: outcome.charter.version,
          currentTier: outcome.charter.currentTier,
          groomed: outcome.groomed,
          semanticMemoryCount: outcome.charter.semanticMemory.length,
          semanticMemory: outcome.charter.semanticMemory.map(m => ({
            id: m.id,
            fact: m.fact.slice(0, 200),
            evidenceTier: m.evidenceTier,
            confidence: m.confidence,
            sourceEpisodeIds: m.sourceEpisodeIds,
          })),
          openQuestions: outcome.charter.openQuestions,
        },
      });
    } catch (error) {
      logger.error('deep agent spin failed', error as Error);
      return res.status(500).json({ error: (error as Error).message });
    }
  });

export default handler;
