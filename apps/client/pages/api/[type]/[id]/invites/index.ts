import { InviteEvents, InviteType, Permission } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  FabFile,
  Group,
  Session,
  withTransaction,
  Project,
  fabFileRepository,
  sessionRepository,
  userRepository,
  organizationRepository,
  projectRepository,
  inviteRepository,
  Organization,
} from '@bike4mind/database';
import { BadRequestError } from '@server/utils/errors';
import { z } from 'zod';
import { sharingService } from '@bike4mind/services';
import { logEvent } from '@server/utils/analyticsLog';
import { ProjectEvents } from '@bike4mind/common';
import { EmailEvents } from '@server/utils/eventBus';

interface IParams {
  type?: string;
  id?: string;
}

// Map URL path types to InviteType enum values
const URL_PATH_TO_INVITE_TYPE = {
  files: InviteType.FabFile,
  sessions: InviteType.Session,
  projects: InviteType.Project,
  groups: InviteType.Group,
  organizations: InviteType.Organization,
  tools: InviteType.Tool,
};

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
  /**
   * GET /api/:type/invites/:id - Retrieves all pending invitations for a document
   */
  .get(
    asyncHandler<{}, unknown, unknown, IParams>(async (req, res) => {
      const type: string | undefined = req.query.type;
      const id: string | undefined = req.query.id;

      if (!id) {
        return res.status(400).json({ message: 'Invalid get invite request' });
      }

      // Map URL path type to InviteType enum value for consistency
      const inviteType = URL_PATH_TO_INVITE_TYPE[type as keyof typeof URL_PATH_TO_INVITE_TYPE];
      if (!inviteType) {
        return res.status(400).json({ message: 'Invalid type' });
      }

      // Share-scoped: the service authorizes via the document's share access
      // (owner, a users[]-with-share grant, or a groups[]-with-share grant),
      // replacing the app-level CASL check.
      const shares = await sharingService.listInvitesForDocument(
        req.user,
        { documentId: id, type: inviteType },
        {
          db: {
            invites: inviteRepository,
            fabFiles: fabFileRepository,
            sessions: sessionRepository,
            projects: projectRepository,
            organizations: organizationRepository,
            groups: Group,
          },
        }
      );
      return res.json(shares);
    })
  )
  /**
   * POST /api/:type/:id/invites
   * - Creates a new invitation.  If one or more email addresses given, will also send email(s) to the given addresses.
   */
  .post(
    asyncHandler<{}, unknown, z.infer<typeof CreateInviteRequestSchema>, IParams>(async (req, res) => {
      const { type: urlPathType, id } = req.query;
      if (!urlPathType || !id) {
        return res.status(400).json({ message: 'Invalid invite request' });
      }

      // Map URL path type to InviteType enum value
      const inviteType = URL_PATH_TO_INVITE_TYPE[urlPathType as keyof typeof URL_PATH_TO_INVITE_TYPE];
      if (!inviteType) throw new BadRequestError('Invalid type');

      const created = await withTransaction(() => {
        return sharingService.createInvite(
          req.user,
          { id, type: inviteType, ...(req.body as any) },
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

      // Log invite creation event
      await logEvent(
        {
          userId: req.user.id,
          type: InviteEvents.CREATE_INVITE,
          metadata: { id: created.id, totalInvites: created.recipients?.pending?.length ?? 0 },
        },
        { ability: req.ability }
      );

      // If this is a project invite, also log ADD_MEMBER event
      if (inviteType === InviteType.Project) {
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
      }

      // Send email notifications to recipients
      const pendingRecipients = created.recipients?.pending || [];
      if (pendingRecipients.length > 0) {
        const inviteLink = generateInviteLink(created.id);
        const documentName = await getDocumentName(inviteType, id);
        const typeName = getTypeName(inviteType);
        const brand = process.env.APP_NAME || '';
        const sharerName = req.user.name || req.user.username || `A${brand ? ` ${brand}` : ''} user`;
        const sharerEmail = req.user.email || '';

        // Send notifications asynchronously - don't block the response
        sendInviteNotificationEmails(
          pendingRecipients,
          sharerName,
          sharerEmail,
          documentName,
          typeName,
          inviteLink,
          req.body.description
        ).catch(error => {
          req.logger?.error('Failed to send invite notification emails', { error, inviteId: created.id });
        });
      }

      return res.json({ ...created, link: generateInviteLink(created.id) });
    })
  )
  /**
   * DELETE /api/:type/:id/invites
   *
   * Cancel any open invites for a document
   */
  .delete(
    asyncHandler<{}, unknown, unknown, IParams>(async (req, res) => {
      const invites = await sharingService.cancelInvite(
        req.user,
        { ...(req.query as any), ...(req.body as any) },
        {
          db: {
            invites: inviteRepository,
            users: userRepository,
            fabFiles: fabFileRepository,
            sessions: sessionRepository,
            organizations: organizationRepository,
            groups: Group,
          },
        }
      );

      await logEvent(
        {
          userId: req.user.id,
          type: InviteEvents.DELETE_INVITE,
          metadata: { documentId: invites[0].documentId, documentType: invites[0].type },
        },
        { ability: req.ability }
      );

      return res.json(invites);
    })
  );

export const generateInviteLink = (id: string) => {
  return `${process.env.APP_URL}/share/${id}`;
};

// Helper to get document name for email
const getDocumentName = async (type: InviteType, id: string): Promise<string> => {
  switch (type) {
    case InviteType.FabFile: {
      const file = await FabFile.findById(id);
      return file?.fileName || 'a file';
    }
    case InviteType.Session: {
      const session = await Session.findById(id);
      return session?.name || 'a notebook';
    }
    case InviteType.Project: {
      const project = await Project.findById(id);
      return project?.name || 'a project';
    }
    case InviteType.Organization: {
      const org = await Organization.findById(id);
      return org?.name || 'an organization';
    }
    case InviteType.Group: {
      const group = await Group.findById(id);
      return group?.name || 'a group';
    }
    default:
      return 'content';
  }
};

// Helper to get human-readable type name
const getTypeName = (type: InviteType): string => {
  switch (type) {
    case InviteType.FabFile:
      return 'file';
    case InviteType.Session:
      return 'notebook';
    case InviteType.Project:
      return 'project';
    case InviteType.Organization:
      return 'organization';
    case InviteType.Group:
      return 'group';
    default:
      return 'content';
  }
};

// Escape HTML to prevent XSS/injection attacks in email templates
const escapeHtml = (str: string): string =>
  str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Send email notification to invite recipients
const sendInviteNotificationEmails = async (
  recipients: string[],
  sharerName: string,
  sharerEmail: string,
  documentName: string,
  typeName: string,
  inviteLink: string,
  description?: string
) => {
  const brand = process.env.APP_NAME || '';
  const emailBody = `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .header {
            border-bottom: 3px solid #1976d2;
            padding-bottom: 20px;
            margin-bottom: 30px;
          }
          .content {
            margin: 20px 0;
          }
          .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #e0e0e0;
            font-size: 12px;
            color: #666666;
          }
          h1 {
            color: #1976d2;
            font-size: 24px;
            margin: 0;
          }
          .cta-button {
            display: inline-block;
            background-color: #1976d2;
            color: white !important;
            padding: 12px 24px;
            text-decoration: none;
            border-radius: 6px;
            font-weight: 600;
            margin: 20px 0;
          }
          .description {
            background-color: #f5f5f5;
            padding: 15px;
            border-radius: 8px;
            border-left: 4px solid #1976d2;
            margin: 20px 0;
            font-style: italic;
          }
          .shared-item {
            background-color: #e3f2fd;
            padding: 15px;
            border-radius: 8px;
            margin: 20px 0;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>You've Been Invited!</h1>
        </div>

        <div class="content">
          <p>Hello!</p>

          <p><strong>${escapeHtml(sharerName)}</strong> (${escapeHtml(sharerEmail)}) has shared a ${typeName} with you${brand ? ` on ${brand}` : ''}.</p>

          <div class="shared-item">
            <strong>${typeName.charAt(0).toUpperCase() + typeName.slice(1)}:</strong> ${escapeHtml(documentName)}
          </div>

          ${
            description
              ? `
          <div class="description">
            <strong>Message:</strong><br/>
            ${escapeHtml(description).replace(/\n/g, '<br/>')}
          </div>
          `
              : ''
          }

          <div style="text-align: center;">
            <a href="${inviteLink}" class="cta-button">Accept Invitation</a>
          </div>

          <p style="margin-top: 30px; font-size: 14px; color: #666;">
            Click the button above to view and accept this invitation. If you don't have a${brand ? ` ${brand}` : 'n'} account yet, you'll be prompted to create one.
          </p>
        </div>

        <div class="footer">
          <p>This email was sent${brand ? ` from ${brand}, an AI collaboration platform` : ''}.</p>
          <p>If you have questions about this invitation, please contact ${escapeHtml(sharerName)} at ${escapeHtml(sharerEmail)}.</p>
        </div>
      </body>
    </html>
  `;

  // Email subjects don't render HTML, but escaping prevents header injection.
  const emailPromises = recipients.map(recipient =>
    EmailEvents.Send.publish({
      to: recipient,
      subject: `${escapeHtml(sharerName)} shared a ${typeName} with you${brand ? ` on ${brand}` : ''}`,
      body: emailBody,
    }).catch(error => {
      console.error(`Failed to send invite notification to ${recipient}:`, error);
    })
  );

  await Promise.allSettled(emailPromises);
};

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
