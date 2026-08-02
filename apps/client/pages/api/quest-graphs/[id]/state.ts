import { questGraphRepository, questNodeRepository } from '@bike4mind/database';
import { BadRequestError, UnauthorizedError } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { requireUser } from '@server/middlewares/requireUser';
import { requireExperimentalFeature } from '@server/middlewares/requireExperimentalFeature';
import { respond } from '@server/utils/respond';
import { requireOwnedGraph } from '@server/questmaster/v5/questGraphAccess';
import { loadGraphDetail } from '@server/questmaster/v5/loadGraphDetail';
import { QuestGraphDetailResponseSchema } from '@server/questmaster/v5/wire';
import { Logger } from '@bike4mind/observability';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

const stateRateLimit = rateLimit({ limit: 60, windowMs: 60000 });

/**
 * Only the two transitions a person drives. `completed` is the scheduler's to
 * declare, and `draft`/`archived` are not reachable from this surface yet -
 * accepting arbitrary states here would let a caller mark a graph finished
 * while its work is still running.
 */
const StateSchema = z.object({ state: z.enum(['active', 'paused']) });

const logger = new Logger({ metadata: { component: 'questmaster-v5-state' } });

const handler = baseApi()
  .use(requireUser)
  .use(requireExperimentalFeature('enableQuestMasterV5'))
  .put<NextApiRequest, NextApiResponse>(csrfProtection(), stateRateLimit, async (req, res) => {
    if (!req.user?.id) throw new UnauthorizedError('User required');
    const { id } = req.query;
    if (typeof id !== 'string') throw new BadRequestError('Graph id required');

    const { state } = StateSchema.parse(req.body);
    const graph = await requireOwnedGraph(id, req.user.id);

    // `completed` is the scheduler's to declare and `archived` is terminal, so
    // neither may be reactivated here. Without this the docstring above was
    // claiming a guarantee the code did not make: a direct call could restart a
    // finished quest, and the scheduler would then find nothing to do and
    // complete it again.
    if (graph.state === 'completed' || graph.state === 'archived') {
      throw new BadRequestError(`A ${graph.state} quest cannot be started or paused`);
    }

    if (state === 'active') {
      // Starting an empty graph would immediately conclude there is nothing to
      // do and complete it, which reads as a bug rather than as an empty quest.
      const nodes = await questNodeRepository.getNodes(graph.id);
      if (!nodes.some(n => n.kind === 'task')) {
        throw new BadRequestError('This quest has no tasks to run yet - generate or add some first');
      }
    }

    const updated = (await questGraphRepository.updateState(graph.id, state)) ?? graph;

    // Deliberately does NOT advance here. Starting a graph should return
    // promptly; the first tick belongs to the next poll, which carries the model
    // the scheduler needs anyway.
    respond(res, QuestGraphDetailResponseSchema, await loadGraphDetail(updated, logger));
  });

export default handler;
