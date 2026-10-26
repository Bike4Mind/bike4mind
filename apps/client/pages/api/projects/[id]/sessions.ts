import { projectRepository, sessionRepository, userRepository } from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  assertProjectsReadScope,
  assertProjectsWriteScope,
  PROJECTS_READ_OR_WRITE_SCOPES,
} from '@server/projects/projectScopes';
import { attachSessionsToProject } from '@server/projects/attachSessionsToProject';
import { removeSessionsFromProject } from '@server/projects/projectContentMutations';
import { redactSessionsForClient } from '@bike4mind/common';
import { z } from 'zod';

// Shape stays loose (no hex check) for the reason recorded above ProjectFilesRequestSchema in
// types/api.ts: the queries behind addSessions/removeSessions guard ids themselves.
const sessionIdsArray = z.array(z.string().min(1));

const addSessionIdsBodySchema = z.object({ sessionIds: sessionIdsArray.min(1) });

// No .min(1): removeSessions (b4m-core) is a no-op on an empty array, and this route is
// API-key reachable, so DELETE stays as lenient as the sibling files.ts route.
const removeSessionIdsBodySchema = z.object({ sessionIds: sessionIdsArray });

// baseApi's scope gate is per route, so it admits either projects scope and each method asserts its own.
const handler = baseApi({ requiredScopes: PROJECTS_READ_OR_WRITE_SCOPES })
  .get(
    asyncHandler<{ id: string }>(async (req, res) => {
      assertProjectsReadScope(req);
      const { id } = req.query as { id: string };
      const sessions = await projectService.listSessions(
        req.user.id,
        {
          projectId: id,
        },
        {
          db: {
            sessions: sessionRepository,
            projects: projectRepository,
            users: userRepository,
          },
        }
      );
      return res.json(redactSessionsForClient(sessions));
    })
  )
  .post(
    asyncHandler<{ id: string }>(async (req, res) => {
      assertProjectsWriteScope(req);
      const { id } = req.query as { id: string };
      const { sessionIds } = addSessionIdsBodySchema.parse(req.body);

      const sessions = await attachSessionsToProject(
        { user: req.user, ability: req.ability, logger: req.logger },
        id,
        sessionIds as [string, ...string[]]
      );

      return res.json(redactSessionsForClient(sessions));
    })
  )
  .delete(
    asyncHandler<{ id: string }>(async (req, res) => {
      assertProjectsWriteScope(req);
      const { id } = req.query as { id: string };
      const { sessionIds } = removeSessionIdsBodySchema.parse(req.body);

      const project = await removeSessionsFromProject(
        { user: req.user, ability: req.ability, logger: req.logger },
        id,
        sessionIds
      );

      return res.json(project);
    })
  );

export default handler;
