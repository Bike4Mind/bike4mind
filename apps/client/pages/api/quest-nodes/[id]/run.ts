import { isNodeReady, questNodeRepository } from '@bike4mind/database';
import { BadRequestError, UnauthorizedError } from '@bike4mind/common';
import type { NodeStatus } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { requireUser } from '@server/middlewares/requireUser';
import { requireExperimentalFeature } from '@server/middlewares/requireExperimentalFeature';
import { respond } from '@server/utils/respond';
import { requireOwnedNode } from '@server/questmaster/v5/questGraphAccess';
import { runQuestNode } from '@server/questmaster/v5/runQuestNode';
import { QuestNodeRunResponseSchema, toQuestNodeWire } from '@server/questmaster/v5/wire';
import { Logger } from '@bike4mind/observability';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

// Each run dispatches a billable agent execution, so this is deliberately
// tighter than the graph-editing routes.
const runRateLimit = rateLimit({ limit: 20, windowMs: 60000 });

// No `organizationId`: accepting one from the caller would bill an arbitrary
// org's credit pool, and the membership validation that makes it safe (see
// `agentExecute.handleStart`) is not worth carrying until a v5 run actually
// needs org billing. Phase 1 runs bill the user.
const RunNodeSchema = z.object({
  model: z.string().min(1),
});

const logger = new Logger({ metadata: { component: 'questmaster-v5-run' } });

const handler = baseApi()
  .use(requireUser)
  .use(requireExperimentalFeature('enableQuestMasterV5'))
  .post<NextApiRequest, NextApiResponse>(csrfProtection(), runRateLimit, async (req, res) => {
    if (!req.user?.id) throw new UnauthorizedError('User required');
    const { id } = req.query;
    if (typeof id !== 'string') throw new BadRequestError('Node id required');

    const input = RunNodeSchema.parse(req.body);
    const { node, graph } = await requireOwnedNode(id, req.user.id);

    // Dependency gating is enforced here, not just surfaced in the UI: running
    // a node whose inputs have not been produced yet burns credits on a run
    // that cannot succeed. Phase 2's scheduler picks from the same predicate.
    const siblings = await questNodeRepository.getNodes(graph.id);
    const statusById = new Map<string, NodeStatus>(siblings.map(n => [n.id, n.status]));
    const unmetDeps = node.dependsOn.filter(dep => {
      const s = statusById.get(dep);
      return s !== 'completed' && s !== 'skipped';
    });
    if (unmetDeps.length) {
      throw new BadRequestError(`Node has ${unmetDeps.length} unmet dependency(ies)`);
    }

    const { executionId, node: dispatched } = await runQuestNode({
      node,
      graph,
      userId: req.user.id,
      model: input.model,
      logger,
    });

    respond(
      res,
      QuestNodeRunResponseSchema,
      {
        executionId,
        node: toQuestNodeWire(dispatched, {
          isReady: isNodeReady(dispatched, statusById),
          run: null,
        }),
      },
      202
    );
  });

export default handler;
