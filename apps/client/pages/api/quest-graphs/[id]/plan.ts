import { BadRequestError, UnauthorizedError } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { requireUser } from '@server/middlewares/requireUser';
import { requireExperimentalFeature } from '@server/middlewares/requireExperimentalFeature';
import { respond } from '@server/utils/respond';
import { requireOwnedGraph } from '@server/questmaster/v5/questGraphAccess';
import { generateQuestPlan } from '@server/questmaster/v5/generateQuestPlan';
import { loadGraphDetail } from '@server/questmaster/v5/loadGraphDetail';
import { QuestGraphDetailResponseSchema } from '@server/questmaster/v5/wire';
import { Logger } from '@bike4mind/observability';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

// Each call is one billable LLM completion, so this is tighter than the
// graph-editing routes and matches the node-run limit.
const planRateLimit = rateLimit({ limit: 20, windowMs: 60000 });

const PlanSchema = z.object({ model: z.string().min(1) });

const logger = new Logger({ metadata: { component: 'questmaster-v5-plan' } });

/**
 * Generate a plan for a quest: a spine of phases, each with its task nodes.
 *
 * Returns the whole graph detail rather than just a count, so the caller renders
 * the new structure from one response instead of firing a follow-up read.
 */
const handler = baseApi()
  .use(requireUser)
  .use(requireExperimentalFeature('enableQuestMasterV5'))
  .post<NextApiRequest, NextApiResponse>(csrfProtection(), planRateLimit, async (req, res) => {
    if (!req.user?.id) throw new UnauthorizedError('User required');
    const { id } = req.query;
    if (typeof id !== 'string') throw new BadRequestError('Graph id required');

    const { model } = PlanSchema.parse(req.body);
    const graph = await requireOwnedGraph(id, req.user.id);

    await generateQuestPlan({ graph, userId: req.user.id, model, logger });

    respond(res, QuestGraphDetailResponseSchema, await loadGraphDetail(graph, logger));
  });

export default handler;
