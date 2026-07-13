import { RegInviteEvents, requireEnv } from '@bike4mind/common';
import { userService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database';
import { logEvent } from '@server/utils/analyticsLog';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { EmailEvents } from '@server/utils/eventBus';
import { getLogoUrl, buildEmailLogoImg } from '@server/utils/mailer/emailHelpers';
import { addUserToOrganization } from '@server/managers/organizationManager';
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

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');

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
        const username = name.replace(/\s/g, '');
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
        await userRepository.update({ id: userId, organizationId: orgId });
        await addUserToOrganization({
          organizationId: orgId,
          userId,
          force: true,
        });
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

  return res.json({ message: 'User migration initiated successfully', createdUsers });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
