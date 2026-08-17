import { z } from 'zod';
import { Permission, ProjectEvents } from '@bike4mind/common';
import { Project, projectRepository } from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import qs from 'qs';
import { accessibleBy } from '@casl/mongoose';
import { InternalServerError, UnprocessableEntityError } from '@bike4mind/utils';
import { logEvent } from '@server/utils/analyticsLog';

const createProjectBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  sessionIds: z.array(z.string()).optional(),
  fileIds: z.array(z.string()).optional(),
});

const handler = baseApi()
  .get(async (req, res) => {
    const scope = !!req.ability ? accessibleBy(req.ability, Permission.read).ofType(Project) : { userId: req.user.id };
    const params = {
      ...qs.parse(req.query as Record<string, any>),
      filters: {
        scope,
      },
    };
    const projects = await projectService.searchProjects(req.user.id, params, {
      db: {
        projects: projectRepository,
      },
    });

    return res.json(projects);
  })
  .post(async (req, res) => {
    try {
      const body = createProjectBodySchema.parse(req.body);
      const project = await projectService.createProject(req.user.id, body, {
        db: {
          projects: projectRepository,
        },
      });

      await logEvent(
        {
          userId: req.user.id,
          type: ProjectEvents.CREATE_PROJECT,
          metadata: {
            projectId: project.id,
            projectName: project.name,
          },
        },
        { ability: req.ability }
      );

      if (body.sessionIds?.length) {
        await Promise.all(
          body.sessionIds.map((sessionId: string) =>
            logEvent(
              {
                userId: req.user.id,
                type: ProjectEvents.ADD_SESSION,
                metadata: {
                  projectId: project.id,
                  projectName: project.name,
                  contentId: sessionId,
                  contentType: 'session',
                },
              },
              { ability: req.ability }
            )
          )
        );
      }

      if (body.fileIds?.length) {
        await Promise.all(
          body.fileIds.map((fileId: string) =>
            logEvent(
              {
                userId: req.user.id,
                type: ProjectEvents.ADD_FILE,
                metadata: {
                  projectId: project.id,
                  projectName: project.name,
                  contentId: fileId,
                  contentType: 'file',
                },
              },
              { ability: req.ability }
            )
          )
        );
      }

      return res.json(project);
    } catch (error) {
      if ((error as { code?: number })?.code === 11000) {
        throw new UnprocessableEntityError(`Project ${req.body.name} already exists`);
      } else {
        throw new InternalServerError((error as Error).message);
      }
    }
  });

export default handler;
