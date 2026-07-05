import { baseApi } from '@server/middlewares/baseApi';
import { inviteRepository, projectRepository } from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { sharingService } from '@bike4mind/services';
import { InviteEvents, InviteType, ProjectEvents, Permission } from '@bike4mind/common';
import { logEvent } from '@server/utils/analyticsLog';
import {
  withTransaction,
  userRepository,
  fabFileRepository,
  sessionRepository,
  organizationRepository,
  Project,
  Group,
} from '@bike4mind/database';
import { z } from 'zod';

// Used only for type inference via z.infer<typeof ...>
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const CreateInviteRequestSchema = z.object({
  permissions: z.array(z.enum(Object.keys(Permission) as [string, ...string[]])),
  recipients: z.string().array().optional(),
  description: z.string().optional(),
  expiresAt: z.date().optional(),
  available: z.number().prefault(1).optional(),
});

const handler = baseApi()
  .get(async (req, res) => {
    const result = await projectService.listInvites(req.user!, req.query as any, {
      db: {
        projects: projectRepository,
        invites: inviteRepository,
      },
      ability: req.ability,
    });

    return res.json(result);
  })
  .post(
    asyncHandler<{}, unknown, z.infer<typeof CreateInviteRequestSchema>>(async (req, res) => {
      const { id } = req.query as { id: string };
      if (!id || typeof id !== 'string') {
        return res.status(400).json({ message: 'Invalid project ID' });
      }

      const created = await withTransaction(() => {
        return sharingService.createInvite(
          req.user,
          { id, type: InviteType.Project, ...(req.body as any) },
          {
            db: {
              invites: inviteRepository,
              users: userRepository,
              fabFiles: fabFileRepository,
              sessions: sessionRepository,
              projects: projectRepository,
              organizations: organizationRepository,
              groups: Group,
            },
          }
        );
      });

      await logEvent(
        {
          userId: req.user.id,
          type: InviteEvents.CREATE_INVITE,
          metadata: { id: created.id, totalInvites: created.recipients?.pending?.length ?? 0 },
        },
        { ability: req.ability }
      );

      const project = await Project.findById(id);
      if (project) {
        await Promise.all(
          (created.recipients?.pending || []).map(async (recipientId: string) =>
            logEvent(
              {
                userId: req.user.id,
                type: ProjectEvents.ADD_MEMBER,
                metadata: {
                  projectId: id,
                  projectName: project.name,
                  memberId: recipientId,
                  memberRole: (req.body.permissions || []).join(','),
                },
              },
              { ability: req.ability }
            )
          )
        );
      }

      const generateInviteLink = (inviteId: string) => {
        return `${process.env.APP_URL}/share/${inviteId}`;
      };

      return res.json({ ...created, link: generateInviteLink(created.id) });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
