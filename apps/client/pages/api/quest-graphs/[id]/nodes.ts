import { isNodeReady, isNodeRunnable, questGraphRepository, questNodeRepository } from '@bike4mind/database';
import { BadRequestError, NODE_KIND_VALUES, UnauthorizedError } from '@bike4mind/common';
import type { NodeStatus } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { requireUser } from '@server/middlewares/requireUser';
import { requireExperimentalFeature } from '@server/middlewares/requireExperimentalFeature';
import { respond } from '@server/utils/respond';
import { requireOwnedGraph } from '@server/questmaster/v5/questGraphAccess';
import { QuestNodeCreatedResponseSchema, toQuestNodeWire } from '@server/questmaster/v5/wire';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

const createRateLimit = rateLimit({ limit: 60, windowMs: 60000 });

const AddNodeSchema = z.object({
  title: z.string().min(1).max(500),
  task: z.string().min(1).max(8000),
  acceptanceCriteria: z.string().max(8000).optional(),
  parentId: z.string().min(1).nullable().optional(),
  dependsOn: z.array(z.string().min(1)).max(50).optional(),
  order: z.number().int().min(0).optional(),
  kind: z.enum(NODE_KIND_VALUES).optional(),
  enabledTools: z.array(z.string().min(1)).max(100).optional(),
});

/**
 * The repository enforces the graph invariants (node budget, depth cap,
 * dependency existence, cycle guard) by throwing plain Errors. Map the ones a
 * caller can actually cause onto 400s so a bad request doesn't read as a
 * server fault; anything else is a real failure and rethrows as a 500.
 */
const CALLER_FIXABLE_INVARIANTS = new Set([
  'node budget exceeded',
  'max depth exceeded',
  'parent node not found',
  'dependency not found',
  'dependency cycle detected',
]);

const handler = baseApi()
  .use(requireUser)
  .use(requireExperimentalFeature('enableQuestMasterV5'))
  .post<NextApiRequest, NextApiResponse>(csrfProtection(), createRateLimit, async (req, res) => {
    if (!req.user?.id) throw new UnauthorizedError('User required');
    const { id } = req.query;
    if (typeof id !== 'string') throw new BadRequestError('Graph id required');

    const graph = await requireOwnedGraph(id, req.user.id);
    const input = AddNodeSchema.parse(req.body);

    let node;
    try {
      node = await questNodeRepository.addNode({
        graphId: graph.id,
        title: input.title,
        task: input.task,
        acceptanceCriteria: input.acceptanceCriteria,
        parentId: input.parentId ?? null,
        dependsOn: input.dependsOn,
        order: input.order,
        kind: input.kind,
        enabledTools: input.enabledTools,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (CALLER_FIXABLE_INVARIANTS.has(message)) throw new BadRequestError(message);
      throw err;
    }

    // A root node (no parent) is what the graph hangs off; without this the
    // graph would have nodes but an empty `rootNodeIds` and no entry point.
    if (!node.parentId) await questGraphRepository.addRootNode(graph.id, node.id);

    const siblings = await questNodeRepository.getNodes(graph.id);
    const statusById = new Map<string, NodeStatus>(siblings.map(n => [n.id, n.status]));

    respond(
      res,
      QuestNodeCreatedResponseSchema,
      {
        node: toQuestNodeWire(node, {
          isReady: isNodeReady(node, statusById),
          isRunnable: isNodeRunnable(node, statusById),
          run: null,
        }),
      },
      201
    );
  });

export default handler;
