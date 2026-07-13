import { baseApi } from '@server/middlewares/baseApi';
import { userRepository, pendingOtcTokenRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { EmailEvents } from '@server/utils/eventBus';
import { getLogoUrl, buildEmailLogoImg } from '@server/utils/mailer/emailHelpers';
import { Config } from '@server/utils/config';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

const createUserSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  email: z.email('Invalid email address'),
  name: z.string().min(1, 'Name is required'),
  // Passwordless (OTC): a password is no longer used to sign in. Optional for
  // backward compat; if omitted, an unusable random value is stored.
  password: z.string().min(6, 'Password must be at least 6 characters').optional(),
  isAdmin: z.boolean().optional().prefault(false),
  level: z.enum(['DemoUser', 'PaidUser', 'VIPUser', 'ManagerUser', 'AdminUser']).optional().prefault('DemoUser'),
  initialCredits: z.number().min(0).optional().prefault(0),
  storageLimit: z.number().min(0).optional().prefault(1000),
  tags: z.array(z.string()).optional().prefault([]),
});

type CreateUserInput = z.infer<typeof createUserSchema>;

const handler = baseApi().post(
  asyncHandler<{}, unknown, CreateUserInput>(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    let validatedData: CreateUserInput;
    try {
      validatedData = createUserSchema.parse(req.body);
    } catch (error: any) {
      if (error.issues && Array.isArray(error.issues)) {
        // Format Zod errors to be more user-friendly
        const errorMessages = error.issues
          .map((e: any) => {
            const field = e.path.join('.');
            return field ? `${field}: ${e.message}` : e.message;
          })
          .join('; ');
        throw new BadRequestError(errorMessages);
      }
      throw new BadRequestError('Invalid input data');
    }

    try {
      const newUser = await userService.createUser(
        {
          username: validatedData.username,
          email: validatedData.email,
          name: validatedData.name,
          isAdmin: validatedData.isAdmin,
          level: validatedData.level,
          initialCredits: validatedData.initialCredits,
          // Pass tags through as-is (zod prefaults to []); createUser stores []
          // rather than null so a tag-less user isn't stuck "Loading AI models...".
          tags: validatedData.tags,
          record: {
            // Passwordless mode: store null rather than a fake password when the
            // admin doesn't supply one, so `password` presence stays a truthful
            // signal. The user signs in via OTC. hasUsablePassword mirrors whether
            // a real password was supplied.
            password: validatedData.password ?? null,
            hasUsablePassword: !!validatedData.password,
            storageLimit: validatedData.storageLimit,
          },
        },
        {
          db: {
            users: userRepository,
          },
        }
      );

      // Send OTC welcome email so the new user knows how to sign in.
      // Failures are non-fatal - the user is created regardless.
      try {
        const brand = process.env.APP_NAME || '';
        const logoUrl = getLogoUrl();
        const result = await userService.sendOTC(
          { email: newUser.email! },
          {
            mailer: {
              sendOTCEmail: async (toEmail, code) => {
                const emailBody = `
<!DOCTYPE html>
<html>
  <head>
    <style>
      body { font-family: Arial, sans-serif; line-height: 1.5; color: #333333; }
      .content { margin: 20px; }
      .code { font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1a82e2; padding: 16px 24px; background: #f5f5f5; border-radius: 8px; display: inline-block; margin: 16px 0; }
    </style>
  </head>
  <body>
    <div class="content">
      ${buildEmailLogoImg(brand, logoUrl)}
      <h2>You've been invited${brand ? ` to ${brand}` : ''}</h2>
      <p>An admin has created an account for you. Use the code below to sign in for the first time.</p>
      <div class="code">${code}</div>
      <p>This code expires in 10 minutes. If you need a new one, visit the sign-in page and enter your email address.</p>
    </div>
  </body>
</html>`;
                await EmailEvents.Send.publish({
                  to: toEmail,
                  subject: `You've been invited${brand ? ` to ${brand}` : ''} — sign-in code`,
                  body: emailBody,
                });
              },
            },
            signPendingToken: payload => jwt.sign(payload, Config.JWT_SECRET, { algorithm: 'HS256' }),
          }
        );
        if (result.nonce) {
          await pendingOtcTokenRepository.storeNonce(newUser.email!, result.nonce);
        }
      } catch (err) {
        req.logger.error('Failed to send OTC welcome email for admin-created user', err);
      }

      // Return the created user (without sensitive data)
      res.status(201).json({
        success: true,
        message: 'User created successfully',
        user: {
          id: newUser.id,
          username: newUser.username,
          email: newUser.email,
          name: newUser.name,
          isAdmin: newUser.isAdmin,
          level: newUser.level,
          currentCredits: newUser.currentCredits,
          storageLimit: newUser.storageLimit,
          tags: newUser.tags,
          createdAt: (newUser as any).createdAt,
        },
      });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('already in use')) {
          throw new BadRequestError(error.message);
        }
        throw new BadRequestError(`Failed to create user: ${error.message}`);
      }
      throw new BadRequestError('Failed to create user');
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
