/**
 * GET /api/v1/projects/{id} - the public twin of GET /api/projects/[id].
 *
 * projectService.get answers NotFoundError for an unknown, malformed, deleted or inaccessible id
 * alike, which is exactly the single 404 the contract publishes. Auth mode, scopes and path
 * validation come from `getProjectContract`.
 */
import { getProjectContract } from '@bike4mind/common';
import { projectRepository, userRepository } from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { rateLimit } from '@server/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';
import { toPublicProject } from '@server/projects/toPublicProject';

const handler = nextRouteForContract(getProjectContract, {
  rateLimit: rateLimit({
    limit: req => resolveUserRateLimitPerMin(req.user),
    windowMs: 60 * 1000,
    // Named so every project id shares one bucket instead of one per pathname.
    bucket: '/api/v1/projects/[id]',
  }),
}).get(async (req, res) => {
  const project = await projectService.get(
    req.user.id,
    { id: req.validatedParams.id },
    { db: { projects: projectRepository, users: userRepository } }
  );
  return res.json(toPublicProject(project));
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
