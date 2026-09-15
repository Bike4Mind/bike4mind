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

// z.enum(Permission) produces Permission[] so the service type is satisfied.
const createInviteBodySchema = z.object({
  permissions: z.array(z.enum(Permission)),
  recipients: z.string().array().optional(),
  description: z.string().optional(),
  // null is the client's "no expiry" (hooks/data/invites.ts DataInput) -- map to undefined so
  // the service's 100-year prefault applies. z.coerce.date(null) would silently produce epoch.
  expiresAt: z.preprocess(
    v => (v === null ? undefined : v),
    z.coerce.date().min(new Date(), 'expiresAt must be in the future').optional()
  ),
  available: z.number().optional(),
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
    asyncHandler<{}, unknown, z.infer<typeof createInviteBodySchema>>(async (req, res) => {
      const { id } = req.query as { id: string };
      if (!id || typeof id !== 'string') {
        return res.status(400).json({ message: 'Invalid project ID' });
      }

      const { expiresAt, ...restBody } = createInviteBodySchema.parse(req.body);
      const created = await withTransaction(() => {
        return sharingService.createInvite(
          req.user,
          // id and type come last so path params are always authoritative over any body field.
          { ...restBody, ...(expiresAt !== undefined && { expiresAt }), id, type: InviteType.Project },
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
                  memberRole: (restBody.permissions || []).join(','),
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
