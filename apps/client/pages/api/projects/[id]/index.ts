import { ProjectEvents } from '@bike4mind/common';
import { projectRepository, userRepository } from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { logEvent } from '@server/utils/analyticsLog';

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
    const project = await projectService.update(
      req.user.id,
      {
        ...(req.query as any),
        ...(req.body as any),
      },
      {
        db: {
          projects: projectRepository,
        },
      }
    );

    await logEvent(
      {
        userId: req.user.id,
        type: ProjectEvents.UPDATE_PROJECT,
        metadata: {
          projectId: project.id,
          projectName: project.name,
          updatedFields: Object.keys(req.body),
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
