/**
 * GET  /api/v1/projects/{id}/files - the public, cursor-paginated twin of GET /api/projects/[id]/files.
 * POST /api/v1/projects/{id}/files - the public twin of POST /api/projects/[id]/files.
 *
 * Auth mode, scopes and validation come from the contracts; the SPA route is unchanged and shares
 * the write path through addFilesToProject. The list returns file summaries only (never a signed URL).
 */
import { addProjectFilesContract, listProjectFilesContract } from '@bike4mind/common';
import { fabFileRepository, projectRepository, userRepository } from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { decodeCursor, encodeCursor } from '@server/utils/cursorPagination';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { UnprocessableEntityError } from '@bike4mind/server-utils/utils/errors';
import { toPublicFileSummary } from '@server/files/toPublicFile';
import { toPublicProject } from '@server/projects/toPublicProject';
import { addFilesToProject } from '@server/projects/projectContentMutations';

const CURSOR_SCOPE = 'v1.projects.files';

const listRoute = nextRouteForContract(listProjectFilesContract, {
  rateLimit: perUserRateLimit('GET /api/v1/projects/[id]/files'),
}).get(async (req, res) => {
  const { limit, cursor } = req.validatedQuery;
  const afterId = cursor === undefined ? undefined : decodeCursor(cursor, CURSOR_SCOPE);
  // A cursor carries the last id this endpoint served, so anything else was not minted here.
  if (afterId !== undefined && !isValidObjectId(afterId)) {
    throw new UnprocessableEntityError('Invalid cursor');
  }

  // Same reach as GET /api/v1/projects/{id}; answers 404 for anything the caller cannot read.
  const project = await projectService.get(
    req.user.id,
    { id: req.validatedParams.id },
    { db: { projects: projectRepository, users: userRepository } }
  );

  const page = await fabFileRepository.findPageByIds(project.fileIds, { afterId, limit });
  const lastId = page.data.at(-1)?.id;

  return res.json({
    data: page.data.map(toPublicFileSummary),
    next_cursor: page.hasMore && lastId ? encodeCursor(CURSOR_SCOPE, String(lastId)) : null,
  });
});

const addRoute = nextRouteForContract(addProjectFilesContract, {
  rateLimit: perUserRateLimit('POST /api/v1/projects/[id]/files'),
}).post(async (req, res) => {
  const fileIds = req.validated.file_ids as [string, ...string[]];
  const project = await addFilesToProject(
    { user: req.user, ability: req.ability, logger: req.logger },
    req.validatedParams.id,
    fileIds
  );
  return res.json(toPublicProject(project));
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: listRoute, POST: addRoute });
