/**
 * DELETE /api/v1/projects/{id}/sessions/{session_id} - the single-session twin of
 * DELETE /api/projects/[id]/sessions.
 *
 * The file is named `[session_id]` so Next's dynamic segment matches the contract's path parameter.
 * removeSessions answers 400 for an id the caller cannot read; for a path-addressed resource that is
 * a 404, as is an id that cannot address a row at all.
 */
import { BadRequestError, NotFoundError, removeProjectSessionContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { removeSessionsFromProject } from '@server/projects/projectContentMutations';

const removeRoute = nextRouteForContract(removeProjectSessionContract, {
  rateLimit: perUserRateLimit('DELETE /api/v1/projects/[id]/sessions/[session_id]'),
}).delete(async (req, res) => {
  const { id, session_id: sessionId } = req.validatedParams;
  if (!isValidObjectId(sessionId)) throw new NotFoundError('Session not found');

  try {
    await removeSessionsFromProject({ user: req.user, ability: req.ability, logger: req.logger }, id, [sessionId]);
  } catch (error) {
    if (error instanceof BadRequestError) throw new NotFoundError('Session not found');
    throw error;
  }

  return res.status(204).end();
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ DELETE: removeRoute });
