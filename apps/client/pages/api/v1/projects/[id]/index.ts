/**
 * GET    /api/v1/projects/{id} - the public twin of GET /api/projects/[id].
 * PATCH  /api/v1/projects/{id} - the public twin of PUT /api/projects/[id].
 * DELETE /api/v1/projects/{id} - the public twin of DELETE /api/projects/[id].
 *
 * projectService.get answers NotFoundError for an unknown, malformed, deleted or inaccessible id
 * alike, which is exactly the single 404 the contracts publish. Writes resolve the project through
 * it first, then update/deleteProject's owner-only lookup turns a sharee into the same 404. Auth
 * mode, scopes and validation come from the contracts; the SPA route is unchanged.
 */
import { deleteProjectContract, getProjectContract, ProjectEvents, updateProjectContract } from '@bike4mind/common';
import { fabFileRepository, projectRepository, sessionRepository, userRepository } from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { rateLimit } from '@server/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';
import { isDuplicateKeyError } from '@server/utils/isDuplicateKeyError';
import { logEventSafe } from '@server/utils/analyticsLog';
import { UnprocessableEntityError } from '@server/utils/errors';
import { toPublicProject } from '@server/projects/toPublicProject';

// Named so every project id shares one bucket per method instead of one per pathname.
const perUserRateLimit = (bucket: string) =>
  rateLimit({ limit: req => resolveUserRateLimitPerMin(req.user), windowMs: 60 * 1000, bucket });

const getAccessibleProject = (userId: string, id: string) =>
  projectService.get(userId, { id }, { db: { projects: projectRepository, users: userRepository } });

const getRoute = nextRouteForContract(getProjectContract, {
  rateLimit: perUserRateLimit('/api/v1/projects/[id]'),
}).get(async (req, res) => {
  const project = await getAccessibleProject(req.user.id, req.validatedParams.id);
  return res.json(toPublicProject(project));
});

const updateRoute = nextRouteForContract(updateProjectContract, {
  rateLimit: perUserRateLimit('PATCH /api/v1/projects/[id]'),
}).patch(async (req, res) => {
  const { id } = await getAccessibleProject(req.user.id, req.validatedParams.id);
  const { name } = req.validated;

  let project;
  try {
    // Spread rather than destructured so an omitted field stays absent instead of being set undefined.
    project = await projectService.update(
      req.user.id,
      { ...req.validated, id },
      { db: { projects: projectRepository } }
    );
  } catch (error) {
    // userId_1_name_1 partial-unique index; same status the SPA route answers.
    if (isDuplicateKeyError(error) && name !== undefined) {
      throw new UnprocessableEntityError(`Project ${name} already exists`);
    }
    throw error;
  }

  // Same analytics event PUT /api/projects/[id] emits.
  await logEventSafe(
    {
      userId: req.user.id,
      type: ProjectEvents.UPDATE_PROJECT,
      metadata: { projectId: project.id, projectName: project.name, updatedFields: Object.keys(req.validated) },
    },
    { ability: req.ability },
    req.logger
  );

  return res.json(toPublicProject(project));
});

const deleteRoute = nextRouteForContract(deleteProjectContract, {
  rateLimit: perUserRateLimit('DELETE /api/v1/projects/[id]'),
}).delete(async (req, res) => {
  const project = await getAccessibleProject(req.user.id, req.validatedParams.id);

  await projectService.deleteProject(
    req.user.id,
    { id: project.id },
    {
      db: {
        projects: projectRepository,
        sessions: sessionRepository,
        fabFiles: fabFileRepository,
        users: userRepository,
      },
    }
  );

  // Same analytics event DELETE /api/projects/[id] emits.
  await logEventSafe(
    {
      userId: req.user.id,
      type: ProjectEvents.DELETE_PROJECT,
      metadata: { projectId: project.id, projectName: project.name },
    },
    { ability: req.ability },
    req.logger
  );

  return res.status(204).end();
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: getRoute, PATCH: updateRoute, DELETE: deleteRoute });
