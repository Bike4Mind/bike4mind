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
import { fabFileRepository, projectRepository, sessionRepository, userRepository, Project } from '@bike4mind/database';
import { assertOrgServiceAccountRequest } from '@bike4mind/server-utils/auth/orgServiceAccount';
import { projectService } from '@bike4mind/services';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { cleanUpRevokedFileReferences, projectRevokeCleanupTargets } from '@server/sharing/revokedFileReferences';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@bike4mind/server-utils/utils/userRateTier';
import { isDuplicateKeyError } from '@bike4mind/server-utils/utils/isDuplicateKeyError';
import { logEventSafe } from '@bike4mind/server-utils/utils/analyticsLog';
import { NotFoundError, UnprocessableEntityError } from '@bike4mind/server-utils/utils/errors';
import { toPublicProject } from '@server/projects/toPublicProject';

// Named so every project id shares one bucket per method instead of one per pathname.
const perUserRateLimit = (bucket: string) =>
  rateLimit({ limit: req => resolveUserRateLimitPerMin(req.user, req), windowMs: 60 * 1000, bucket });

const getAccessibleProject = (userId: string, id: string) =>
  projectService.get(userId, { id }, { db: { projects: projectRepository, users: userRepository } });

const getRoute = nextRouteForContract(getProjectContract, {
  rateLimit: perUserRateLimit('/api/v1/projects/[id]'),
}).get(async (req, res) => {
  if (req.user.orgServiceAccount) {
    await assertOrgServiceAccountRequest(req.user, req.apiKeyInfo ?? {}, {
      method: 'GET',
      path: '/api/v1/projects/[id]',
      resourceId: req.validatedParams.id,
    });
    const project = await Project.findOne({
      _id: req.validatedParams.id,
      organizationId: req.user.orgServiceAccount.organizationId,
    }).setOptions({ strictQuery: false });
    if (!project) throw new NotFoundError('Project not found');
    return res.json({ ...toPublicProject(project), session_ids: [], file_ids: [] });
  }
  const project = await getAccessibleProject(req.user.id, req.validatedParams.id);
  return res.json(toPublicProject(project));
});

const updateRoute = nextRouteForContract(updateProjectContract, {
  rateLimit: perUserRateLimit('PATCH /api/v1/projects/[id]'),
}).patch(async (req, res) => {
  const { id } = await getAccessibleProject(req.user.id, req.validatedParams.id);
  const { name } = req.validated;

  // An empty body is a no-op: no updatedAt bump and no analytics event, but still owner-only like a real write.
  if (Object.keys(req.validated).length === 0) {
    const owned = await projectRepository.findByIdAndUserId(id, req.user.id);
    if (!owned) throw new NotFoundError('Project not found');
    return res.json(toPublicProject(owned));
  }

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

  // Read before the delete: its cascade prunes the project's file list.
  const cleanUpTargets = await projectRevokeCleanupTargets(project.id, undefined, req.logger);

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

  await cleanUpRevokedFileReferences(cleanUpTargets, req.logger);

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
