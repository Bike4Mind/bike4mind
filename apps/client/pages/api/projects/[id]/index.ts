import { z } from 'zod';
import { ProjectEvents } from '@bike4mind/common';
import { projectRepository, userRepository } from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import { UnprocessableEntityError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { isDuplicateKeyError } from '@server/utils/isDuplicateKeyError';
import { logEvent } from '@server/utils/analyticsLog';

const updateProjectBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
});

const handler = baseApi()
  .get(async (req, res) => {
    const project = await projectService.get(req.user.id, req.query as any, {
      db: {
        projects: projectRepository,
        users: userRepository,
      },
    });
    return res.json(project);
  })
  .put(async (req, res) => {
    let project;
    const body = updateProjectBodySchema.parse(req.body);
    try {
      project = await projectService.update(
        req.user.id,
        {
          ...(req.query as any),
          ...body,
        },
        {
          db: {
            projects: projectRepository,
          },
        }
      );
    } catch (error) {
      // Renaming to a name the user already has trips the userId_1_name_1 partial-unique
      // index (code 11000). Surface a 4xx instead of a 500 that leaks the raw index name,
      // matching the POST handler in ../index.ts.
      if (isDuplicateKeyError(error) && req.body?.name !== undefined) {
        throw new UnprocessableEntityError(`Project ${req.body.name} already exists`);
      }
      throw error;
    }

    await logEvent(
      {
        userId: req.user.id,
        type: ProjectEvents.UPDATE_PROJECT,
        metadata: {
          projectId: project.id,
          projectName: project.name,
          updatedFields: Object.keys(body),
        },
      },
      { ability: req.ability }
    );

    return res.json(project);
  })
  .delete(async (req, res) => {
    // Get project before deletion for event logging
    const project = await projectService.get(req.user.id, req.query as any, {
      db: {
        projects: projectRepository,
        users: userRepository,
      },
    });

    await projectService.deleteProject(
      req.user.id,
      { ...(req.query as any) },
      {
        db: {
          projects: projectRepository,
        },
      }
    );

    await logEvent(
      {
        userId: req.user.id,
        type: ProjectEvents.DELETE_PROJECT,
        metadata: {
          projectId: project.id,
          projectName: project.name,
        },
      },
      { ability: req.ability }
    );

    return res.status(204).end();
  });

export default handler;
