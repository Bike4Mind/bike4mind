import { userRepository } from '@bike4mind/database';
import { AuthEvents, redactUserSecretsForSelf } from '@bike4mind/common';
import { userService } from '@bike4mind/services';
import { logEvent } from '@server/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { EmailEvents } from '@server/utils/eventBus';
import { getLogoUrl, buildEmailLogoImg } from '@server/utils/mailer/emailHelpers';
import { z } from 'zod';

const userImportSchema = z.object({
  email: z.email('Invalid email format'),
  first: z.string().optional(),
  last: z.string().optional(),
  startingCredits: z.number().int().min(0, 'Credits must be a positive number').optional(),
  startingStorage: z.number().int().min(0, 'Storage must be a positive number').optional(),
  tags: z.array(z.string()).optional(),
});

interface UserImportRow {
  email: string;
  first?: string;
  last?: string;
  startingCredits?: number;
  startingStorage?: number;
  tags?: string[];
}

const handler = baseApi().post(
  asyncHandler<{}, unknown, { users: UserImportRow[] }>(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { users } = req.body;

    if (!Array.isArray(users) || users.length === 0) {
      throw new BadRequestError('Invalid input: users array is required and must not be empty');
    }

    const results = await Promise.all(
      users.map(async userData => {
        try {
          const validatedData = userImportSchema.parse(userData);

          const username = validatedData.email.split('@')[0];

          const newUser = await userService.createUser(
            {
              username,
              email: validatedData.email,
              name: `${validatedData.first || ''} ${validatedData.last || ''}`.trim() || validatedData.email,
              initialCredits: validatedData.startingCredits ?? 0,
              record: {
                // Passwordless: no usable password. Store null so `password`
                // presence stays a truthful signal. Users sign in via OTC.
                password: null,
                hasUsablePassword: false,
              },
            },
            {
              db: {
                users: userRepository,
              },
            }
          );

          // Apply storage limit if provided (createUser hardcodes storageLimit: 1000, so we override after)
          if (validatedData.startingStorage !== undefined) {
            newUser.storageLimit = validatedData.startingStorage;
          }

          if (validatedData.tags && validatedData.tags.length > 0) {
            newUser.tags = validatedData.tags;
          }

          await userRepository.update(newUser);

          const brand = process.env.APP_NAME || '';
          const logoUrl = getLogoUrl();
          const loginLink = `${process.env.APP_URL}/login`;
          const emailBody = `
            <!DOCTYPE html>
            <html>
              <head>
                <style>
                  body {
                    font-family: Arial, sans-serif;
                    line-height: 1.5;
                    color: #333333;
                  }
                  .content {
                    margin: 20px;
                  }
                  .logo {
                    display: block;
                    margin-bottom: 20px;
                  }
                  a {
                    color: #1a82e2;
                  }
                </style>
              </head>
              <body>
                <div class="content">
                  ${buildEmailLogoImg(brand, logoUrl)}
                  <p>Hello ${newUser.name},</p>
                  <p>Welcome${brand ? ` to ${brand}` : ''}! Your account has been created.</p>
                  <p>Sign in at the link below — enter your email and we'll send you a one-time sign-in code. No password needed.</p>
                  <p><a href="${loginLink}">${loginLink}</a></p>
                  <p>If you did not request this account, please ignore this email.</p>
                </div>
              </body>
            </html>
          `;

          await EmailEvents.Send.publish({
            to: newUser.email!,
            subject: `Welcome${brand ? ` to ${brand}` : ''} - Sign In`,
            body: emailBody,
          });

          await logEvent(
            {
              userId: req.user.id,
              type: AuthEvents.REGISTER,
              metadata: {},
            },
            { ability: req.ability }
          );

          return {
            success: true,
            email: newUser.email,
            // Passwordless account (no password login); users sign in via OTC.
            user: redactUserSecretsForSelf(newUser),
          };
        } catch (error: any) {
          if (error instanceof z.ZodError) {
            return {
              success: false,
              email: userData.email,
              error: error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
            };
          }
          return { success: false, email: userData.email, error: error.message || 'Unknown error' };
        }
      })
    );

    return res.json({
      success: true,
      results,
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
