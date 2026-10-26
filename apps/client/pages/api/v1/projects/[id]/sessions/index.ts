/**
 * GET  /api/v1/projects/{id}/sessions - the public, cursor-paginated twin of GET /api/projects/[id]/sessions.
 * POST /api/v1/projects/{id}/sessions - the public twin of POST /api/projects/[id]/sessions.
 *
 * Auth mode, scopes and validation come from the contracts; the SPA route is unchanged and shares the
 * write path (including the credit-gated summary fan-out) through attachSessionsToProject.
 */
import { addProjectSessionsContract, listProjectSessionsContract } from '@bike4mind/common';
import { projectRepository, sessionRepository, userRepository } from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { decodeCursor, encodeCursor } from '@server/utils/cursorPagination';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { UnprocessableEntityError } from '@bike4mind/server-utils/utils/errors';
import { toPublicProject } from '@server/projects/toPublicProject';
import { toPublicSession } from '@server/sessions/toPublicSession';
import { attachSessionsToProject } from '@server/projects/attachSessionsToProject';

const CURSOR_SCOPE = 'v1.projects.sessions';

const getReadableProject = (userId: string, id: string) =>
  projectService.get(userId, { id }, { db: { projects: projectRepository, users: userRepository } });

const listRoute = nextRouteForContract(listProjectSessionsContract, {
  rateLimit: perUserRateLimit('GET /api/v1/projects/[id]/sessions'),
}).get(async (req, res) => {
  const { limit, cursor } = req.validatedQuery;
  const afterId = cursor === undefined ? undefined : decodeCursor(cursor, CURSOR_SCOPE);
  // A cursor carries the last id this endpoint served, so anything else was not minted here.
  if (afterId !== undefined && !isValidObjectId(afterId)) {
    throw new UnprocessableEntityError('Invalid cursor');
  }

  // Same reach as GET /api/v1/projects/{id}; answers 404 for anything the caller cannot read.
  const project = await getReadableProject(req.user.id, req.validatedParams.id);

  const page = await sessionRepository.findPageByIds(project.sessionIds, { afterId, limit });
  const lastId = page.data.at(-1)?.id;

  return res.json({
    data: page.data.map(toPublicSession),
    next_cursor: page.hasMore && lastId ? encodeCursor(CURSOR_SCOPE, String(lastId)) : null,
  });
});

const addRoute = nextRouteForContract(addProjectSessionsContract, {
  rateLimit: perUserRateLimit('POST /api/v1/projects/[id]/sessions'),
}).post(async (req, res) => {
  const { id } = req.validatedParams;
  const sessionIds = req.validated.session_ids as [string, ...string[]];

  await attachSessionsToProject({ user: req.user, ability: req.ability, logger: req.logger }, id, sessionIds);

  // addSessions returns the sessions, not the project, so re-read for the response.
  return res.json(toPublicProject(await getReadableProject(req.user.id, id)));
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: listRoute, POST: addRoute });
