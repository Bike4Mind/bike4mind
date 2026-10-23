import { RegInviteEvents, requireEnv, sanitizeUsername } from '@bike4mind/common';
import { organizationService, userService } from '@bike4mind/services';
import { withTransaction } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { userRepository } from '@bike4mind/database/auth';
import { logEvent } from '@server/utils/analyticsLog';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { EmailEvents } from '@server/utils/eventBus';
import { getLogoUrl, buildEmailLogoImg, escapeHtml } from '@bike4mind/server-utils/utils/mailer/emailHelpers';
import { randomUUID } from 'crypto';
import { z } from 'zod';

const migrateRequestSchema = z.object({
  usersData: z
    .array(
      z.object({
        email: z.string().email(),
        name: z.string().min(1),
      })
    )
    .min(1, 'At least one user is required'),
  sendEmail: z.boolean(),
  orgId: z.string().optional(),
});

function buildMigrationEmailBody(userName: string, loginLink: string): string {
  const brand = process.env.APP_NAME || '';
  const logoUrl = getLogoUrl();
  const safeName = escapeHtml(userName);
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.5; color: #333333; }
          .content { margin: 20px; }
          .logo { display: block; margin-bottom: 20px; }
          a { color: #1a82e2; }
        </style>
      </head>
      <body>
        <div class="content">
          ${buildEmailLogoImg(brand, logoUrl)}
          <p>Hello ${safeName},</p>
          <p>Welcome${brand ? ` to ${escapeHtml(brand)}` : ''}! Your account has been set up and is ready to go.</p>
          <p>To get started, sign in at the link below — enter your email and we'll send you a one-time sign-in code. No password needed.</p>
          <p><a href="${loginLink}">${loginLink}</a></p>
          <p>If you did not expect this email, please ignore it.</p>
        </div>
      </body>
    </html>
  `;
}

const handler = baseApi().post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Only admins can perform user migration');
  }

  const { usersData, sendEmail, orgId } = migrateRequestSchema.parse(req.body);

  const createdUsers: Array<{
    name: string;
    email: string;
  }> = [];

  for (const { email, name } of usersData) {
    try {
      const existingUser = await userRepository.findByEmail(email);

      let userId: string;
      let userName: string;
      let userEmail: string;

      if (!existingUser) {
        const username = sanitizeUsername(name) || `user-${randomUUID().slice(0, 8)}`;
        const newUser = await userService.createUser(
          {
            username,
            email,
            name,
            // Passwordless: no usable password. Store null so `password` presence
            // stays a truthful signal; the user signs in via OTC.
            record: { password: null, hasUsablePassword: false },
          },
          { db: { users: userRepository } }
        );

        userId = newUser.id;
        userName = newUser.name ?? name;
        userEmail = newUser.email ?? email;
      } else {
        userId = existingUser.id;
        userName = existingUser.name ?? name;
        userEmail = existingUser.email ?? email;
      }

      if (orgId) {
        // Admin-only migration path (gated above). addMember fills the user's organizationId
        // itself when it is vacant - which is the case for the accounts this path creates - so no
        // separate user write is needed. An account that already belongs to another org keeps
        // pointing there: the migration adds the roster row, it does not move someone's active org.
        await withTransaction(() =>
          organizationService.addMember(
            req.user,
            { organizationId: orgId, userId, force: true },
            { db: { organizations: organizationRepository, users: userRepository }, logger: req.logger }
          )
        );
      }

      createdUsers.push({
        name: userName,
        email: userEmail,
      });

      await logEvent(
        {
          userId: req.user.id,
          type: RegInviteEvents.MIGRATE_REGINVITE,
          metadata: { email: userEmail, migratedBy: req.user.id },
        },
        { ability: req.ability }
      );

      if (sendEmail) {
        const loginLink = `${requireEnv('APP_URL', process.env.APP_URL)}/login`;
        const emailBody = buildMigrationEmailBody(userName, loginLink);

        const brand = process.env.APP_NAME || '';
        await EmailEvents.Send.publish({
          to: userEmail,
          subject: `Welcome${brand ? ` to ${brand}` : ''} - Sign In`,
          body: emailBody,
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to migrate user ${email}:`, message);
    }
  }

  if (createdUsers.length === 0) {
    throw new BadRequestError('No users were migrated. Check server logs for details.');
  }

  // Best effort: each user is created and added on its own, so a partial run is normal and there
  // is no single transaction to tie a strict entry to; record the outcome once the loop finishes.
  await recordAdminActionFromRequest(req, {
    action: 'user.accounts.migrated',
    target: orgId
      ? { kind: 'organization', id: orgId, displayName: orgId }
      : { kind: 'system', id: 'reg_invite_migration', displayName: 'user migration' },
    summary: `migrated ${createdUsers.length} of ${usersData.length} users`,
    details: {
      requested: usersData.length,
      migrated: createdUsers.length,
      failed: usersData.length - createdUsers.length,
      organizationId: orgId ?? null,
      sendEmail,
    },
  });

  return res.json({ message: 'User migration initiated successfully', createdUsers });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
