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

/**
 * Past this, the response would risk the 6MB API Gateway/Lambda limit, which
 * fails opaquely. No model realistically emits this much, so the point is a
 * legible failure if one ever does - NOT a cap: truncating is the exact bug this
 * endpoint exists to fix, so an oversized reply is withheld whole and the user
 * is pointed at the notebook instead.
 *
 * Measured in BYTES, because the limit it protects is in bytes. A character
 * budget would let a reply of mostly CJK or emoji - three to four UTF-8 bytes
 * apiece - pass the guard at a third of its apparent size and then fail in
 * exactly the opaque way the guard exists to prevent.
 */
const MAX_DELIVERABLE_ANSWER_BYTES = 4_000_000;

const handler = baseApi()
  .use(requireUser)
  .use(requireExperimentalFeature('enableQuestMasterV5'))
  .get<NextApiRequest, NextApiResponse>(async (req, res) => {
    if (!req.user?.id) throw new UnauthorizedError('User required');
    const { id, executionId: requestedExecutionId } = req.query;
    if (typeof id !== 'string') throw new BadRequestError('Node id required');

    // Same ownership rule as every other v5 route: a node you do not own is a
    // 404, not a 403, so this cannot be used to probe for node ids.
    const { node } = await requireOwnedNode(id, req.user.id);

    // Answer for the execution the CLIENT asked about, not whichever one the
    // node points at now. The two diverge on the retry path: a retry mints a new
    // execution, so between the poll that told the client `exec-1` and this
    // request the document can already say `exec-2`. Re-resolving here would
    // return exec-2's reply, which the client then caches under exec-1's key
    // with staleTime: Infinity - the wrong reply, kept forever.
    //
    // The id is client-supplied, so findAnswerByExecutionId scopes it to the
    // caller; an execution belonging to someone else reads as absent.
    const executionId =
      typeof requestedExecutionId === 'string' && requestedExecutionId
        ? requestedExecutionId
        : (node.execution?.agentExecutionId ?? null);

    const stored = executionId
      ? await agentExecutionRepository.findAnswerByExecutionId(executionId, req.user.id)
      : null;

    const tooLarge = stored !== null && Buffer.byteLength(stored, 'utf8') > MAX_DELIVERABLE_ANSWER_BYTES;

    respond(res, QuestNodeAnswerResponseSchema, {
      nodeId: node.id,
      executionId,
      answer: tooLarge ? null : stored,
      unavailableReason: tooLarge ? 'too_large' : null,
    });
  });

export default handler;
