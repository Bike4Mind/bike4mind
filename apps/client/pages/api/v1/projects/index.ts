/**
 * GET  /api/v1/projects - the public, cursor-paginated twin of GET /api/projects.
 * POST /api/v1/projects - the public twin of POST /api/projects.
 *
 * Auth mode, scopes and validation come from `listProjectsContract` / `createProjectContract`; the
 * SPA routes under /api/projects are unchanged. Every response renders through toPublicProject.
 */
import { createProjectContract, HTTPError, listProjectsContract, ProjectEvents } from '@bike4mind/common';
import { fabFileRepository, projectRepository, sessionRepository } from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { rateLimit } from '@server/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';
import { decodeCursor, encodeCursor } from '@server/utils/cursorPagination';
import { isDuplicateKeyError } from '@server/utils/isDuplicateKeyError';
import { isValidObjectId } from '@server/utils/objectId';
import { logEvent } from '@server/utils/analyticsLog';
import { UnprocessableEntityError } from '@server/utils/errors';
import { toPublicProject } from '@server/projects/toPublicProject';

const CURSOR_SCOPE = 'v1.projects';
const perUserRateLimit = (bucket: string) =>
  rateLimit({ limit: req => resolveUserRateLimitPerMin(req.user), windowMs: 60 * 1000, bucket });

const listRoute = nextRouteForContract(listProjectsContract, {
  rateLimit: perUserRateLimit('GET /api/v1/projects'),
}).get(async (req, res) => {
  const { limit, cursor } = req.validatedQuery;
  const afterId = cursor === undefined ? undefined : decodeCursor(cursor, CURSOR_SCOPE);
  // A cursor carries the last id this endpoint served, so anything else was not minted here.
  if (afterId !== undefined && !isValidObjectId(afterId)) {
    throw new UnprocessableEntityError('Invalid cursor');
  }

  // Same reach as GET /api/v1/projects/{id}, so every listed id can be fetched by id.
  const page = await projectRepository.listAccessibleAfterId(req.user, { afterId, limit });
  const lastId = page.data.at(-1)?.id;

  return res.json({
    data: page.data.map(toPublicProject),
    next_cursor: page.hasMore && lastId ? encodeCursor(CURSOR_SCOPE, String(lastId)) : null,
  });
});

const createRoute = nextRouteForContract(createProjectContract, {
  rateLimit: perUserRateLimit('POST /api/v1/projects'),
}).post(async (req, res) => {
  const { name, description, session_ids: sessionIds, file_ids: fileIds } = req.validated;

  let project;
  try {
    project = await projectService.createProject(
      req.user,
      { name, description, sessionIds, fileIds },
      { db: { projects: projectRepository, fabFiles: fabFileRepository, sessions: sessionRepository } }
    );
  } catch (error) {
    // createProject's BadRequestError for an unreadable file/session already carries its 400.
    if (error instanceof HTTPError) throw error;
    // userId_1_name_1 partial-unique index; same status the SPA route answers.
    if (isDuplicateKeyError(error)) throw new UnprocessableEntityError(`Project ${name} already exists`);
    throw error;
  }

  await logProjectCreated(req.user.id, project, { ability: req.ability });

  return res.status(201).json(toPublicProject(project));
});

/** Same analytics events POST /api/projects emits, so API-created projects are not invisible. */
async function logProjectCreated(
  userId: string,
  project: { id: string; name: string; sessionIds: string[]; fileIds: string[] },
  context: Parameters<typeof logEvent>[1]
) {
  const projectMeta = { projectId: project.id, projectName: project.name };
  await Promise.all([
    logEvent({ userId, type: ProjectEvents.CREATE_PROJECT, metadata: projectMeta }, context),
    ...project.sessionIds.map(contentId =>
      logEvent(
        { userId, type: ProjectEvents.ADD_SESSION, metadata: { ...projectMeta, contentId, contentType: 'session' } },
        context
      )
    ),
    ...project.fileIds.map(contentId =>
      logEvent(
        { userId, type: ProjectEvents.ADD_FILE, metadata: { ...projectMeta, contentId, contentType: 'file' } },
        context
      )
    ),
  ]);
}

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: listRoute, POST: createRoute });
