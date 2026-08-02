import { agentExecutionRepository } from '@bike4mind/database';
import { BadRequestError, UnauthorizedError } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { requireUser } from '@server/middlewares/requireUser';
import { requireExperimentalFeature } from '@server/middlewares/requireExperimentalFeature';
import { respond } from '@server/utils/respond';
import { requireOwnedNode } from '@server/questmaster/v5/questGraphAccess';
import { QuestNodeAnswerResponseSchema } from '@server/questmaster/v5/wire';
import { NextApiRequest, NextApiResponse } from 'next';

/**
 * One node's full reply.
 *
 * Split out of the graph-detail payload deliberately. That endpoint is polled
 * every few seconds and the view renders exactly ONE answer - the selected
 * node's - so shipping every node's reply on every tick was waste, and the
 * per-answer character cap that waste forced was itself a bug: it cut replies
 * mid-`<artifact>`, leaving an unclosed tag the parser could not render.
 *
 * Fetching one at a time removes the reason to cap at all, so this returns the
 * reply whole.
 */
const handler = baseApi()
  .use(requireUser)
  .use(requireExperimentalFeature('enableQuestMasterV5'))
  .get<NextApiRequest, NextApiResponse>(async (req, res) => {
    if (!req.user?.id) throw new UnauthorizedError('User required');
    const { id } = req.query;
    if (typeof id !== 'string') throw new BadRequestError('Node id required');

    // Same ownership rule as every other v5 route: a node you do not own is a
    // 404, not a 403, so this cannot be used to probe for node ids.
    const { node } = await requireOwnedNode(id, req.user.id);

    const executionId = node.execution?.agentExecutionId ?? null;
    const answer = executionId ? await agentExecutionRepository.findAnswerByExecutionId(executionId) : null;

    respond(res, QuestNodeAnswerResponseSchema, { nodeId: node.id, executionId, answer });
  });

export default handler;
