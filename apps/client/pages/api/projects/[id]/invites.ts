import { baseApi } from '@server/middlewares/baseApi';
import {
  assertProjectsReadScope,
  assertProjectsWriteScope,
  PROJECTS_READ_OR_WRITE_SCOPES,
} from '@server/projects/projectScopes';
import { cacheRepository, inviteRepository, projectRepository } from '@bike4mind/database';
import { TooManyRequestsError } from '@bike4mind/utils';
import { projectService } from '@bike4mind/services';
import { toSharerInviteViews } from '@server/managers/inviteManager';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { sharingService } from '@bike4mind/services';
import { InviteEvents, InviteType, ProjectEvents, Permission } from '@bike4mind/common';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import {
  withTransaction,
  userRepository,
  fabFileRepository,
  sessionRepository,
  organizationRepository,
  Project,
  Group,
  User,
} from '@bike4mind/database';
import { z } from 'zod';
import { getInviteTypeName, sendInviteNotificationEmails } from '@server/utils/mailer/inviteNotificationEmail';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';

// Creating a project invite emails every recipient, including addresses with no account, with the
// inviter's name, the project name and their message. These bounds keep the route from being a
// free mail relay. The request limit is loose because the Add Members modal sends one request per
// selected user; typed addresses, the only way to reach someone with no account, get their own
// tighter hourly budget, counted per address and the same whether or not the address has an account.
const MAX_INVITE_RECIPIENTS = 25;
const MAX_INVITE_MESSAGE_LENGTH = 1000;
const HOUR_MS = 60 * 60 * 1000;
const PROJECT_INVITE_RATE_LIMIT = { limit: 100, windowMs: HOUR_MS, bucket: 'POST /api/projects/[id]/invites' } as const;
const TYPED_ADDRESS_INVITES_PER_HOUR = 20;

const MAX_EMAILED_NAME_LENGTH = 60;

const capLength = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 3)}...` : value);

/**
 * Emails the invitees. An address with no account gets only the fixed template: no custom message,
 * and the inviter-chosen names capped, so the platform cannot be used to mail free text to
 * strangers. Recipients who already have an account get the message as before. Which is which is
 * never reflected in the response, so the lookup discloses nothing to the inviter.
 */
async function notifyProjectInvitees(params: {
  recipients: string[];
  sharerName: string;
  sharerEmail: string;
  projectName: string;
  inviteLink: string;
  message?: string;
}) {
  const { recipients, sharerName, sharerEmail, projectName, inviteLink, message } = params;
  const accounts = await User.find({ email: { $in: recipients } }, { email: 1 })
    .collation({ locale: 'en', strength: 2 })
    .lean();
  const hasAccount = new Set(accounts.map(account => account.email?.toLowerCase()));
  const members = recipients.filter(recipient => hasAccount.has(recipient.toLowerCase()));
  const strangers = recipients.filter(recipient => !hasAccount.has(recipient.toLowerCase()));
  const typeName = getInviteTypeName(InviteType.Project);

  await Promise.all([
    members.length > 0 &&
      sendInviteNotificationEmails(members, sharerName, sharerEmail, projectName, typeName, inviteLink, message),
    strangers.length > 0 &&
      sendInviteNotificationEmails(
        strangers,
        capLength(sharerName, MAX_EMAILED_NAME_LENGTH),
        sharerEmail,
        capLength(projectName, MAX_EMAILED_NAME_LENGTH),
        typeName,
        inviteLink
      ),
  ]);
}

// z.enum(Permission) produces Permission[] so the service type is satisfied.
const createInviteBodySchema = z.object({
  permissions: z.array(z.enum(Permission)),
  recipients: z.string().array().max(MAX_INVITE_RECIPIENTS).optional(),
  description: z.string().max(MAX_INVITE_MESSAGE_LENGTH).optional(),
  // null is the client's "no expiry" (hooks/data/invites.ts DataInput) -- map to undefined so
  // the service's 100-year prefault applies. z.coerce.date(null) would silently produce epoch.
  expiresAt: z.preprocess(
    v => (v === null ? undefined : v),
    z.coerce.date().min(new Date(), 'expiresAt must be in the future').optional()
  ),
  available: z.number().optional(),
});

// baseApi's scope gate is per route, so it admits either projects scope and each method asserts its own.
const handler = baseApi({ requiredScopes: PROJECTS_READ_OR_WRITE_SCOPES })
  .get(async (req, res) => {
    assertProjectsReadScope(req);
    const result = await projectService.listInvites(req.user!, req.query as any, {
      db: {
        projects: projectRepository,
        invites: inviteRepository,
      },
    });

    // Same reason as the sibling document list: the token is a redeemable secret with no consumer
    // on this surface. Recipient addresses the caller did not type are withheld as well.
    return res.json({ ...result, data: await toSharerInviteViews(result.data, req.user!) });
  })
  .post(
    rateLimit(PROJECT_INVITE_RATE_LIMIT),
    asyncHandler<{}, unknown, z.infer<typeof createInviteBodySchema>>(async (req, res) => {
      assertProjectsWriteScope(req);
      const { id } = req.query as { id: string };
      if (!id || typeof id !== 'string') {
        return res.status(400).json({ message: 'Invalid project ID' });
      }
      // An id that is not an ObjectId names no project, so this route answers the 404 itself
      // rather than letting the lookup cast and raise a CastError.
      if (!isValidObjectId(id)) throw new NotFoundError('Project not found');

      const { expiresAt, ...restBody } = createInviteBodySchema.parse(req.body);

      const typedAddresses = (restBody.recipients ?? []).filter(recipient => recipient.includes('@'));
      for (let i = 0; i < typedAddresses.length; i++) {
        const { success } = await cacheRepository.tryIncrementWithinLimitFixedWindow(
          `rate-limit:${req.user.id}:project-invite-typed-address`,
          TYPED_ADDRESS_INVITES_PER_HOUR,
          HOUR_MS
        );
        if (!success) throw new TooManyRequestsError('Too many email invitations. Try again later.');
      }
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

      // Token, not `_id` - see generateInviteLink in pages/api/[type]/[id]/invites/index.ts for why.
      const generateInviteLink = (invite: { id: string; token?: string }) => {
        return `${process.env.APP_URL}/share/${invite.token ?? invite.id}`;
      };

      // Same notification the generic invite route sends; without it an invitee only learns of the
      // invite from the in-app inbox. Not awaited, so a mail failure never fails the invite.
      const pendingRecipients = created.recipients?.pending || [];
      if (pendingRecipients.length > 0) {
        const brand = process.env.APP_NAME || '';
        notifyProjectInvitees({
          recipients: pendingRecipients,
          sharerName: req.user.name || req.user.username || `A${brand ? ` ${brand}` : ''} user`,
          sharerEmail: req.user.email || '',
          projectName: project?.name || 'a project',
          inviteLink: generateInviteLink(created),
          message: restBody.description,
        }).catch(error => {
          req.logger?.error('Failed to send invite notification emails', { error, inviteId: created.id });
        });
      }

      const [view] = await toSharerInviteViews([created], req.user);
      return res.json({ ...view, link: generateInviteLink(created) });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
